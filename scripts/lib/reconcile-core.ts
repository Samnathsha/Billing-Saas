import type pg from "pg";
import { compare, replay, type ReplayMovement, type StoredBalance } from "./stock-replay";

// The daily reconciliation (Phase 12; blueprint: "invoice totals vs payments
// vs stock movements per tenant, flags any mismatch"). Read-only: it runs in
// a READ ONLY transaction as backup_reader (sees every business, can change
// nothing). Each check is one query listing the rows that do NOT agree; an
// empty list means that check is fine.

export interface Mismatch {
  check: string;
  tenantId: string;
  business: string;
  detail: string;
}

export interface DaySummary {
  tenantId: string;
  business: string;
  bills: number;
  salesPaise: number;
  receivedPaise: number;
  returnsPaise: number;
}

// Constant SQL only, set-based (one pass per check, not per row). $1: the
// businesses to check (NULL: all). Each returns tenant_id and a short detail.
const CHECKS: { name: string; explain: string; sql: string }[] = [
  {
    name: "bill_vs_lines",
    explain: "a bill's totals differ from the sum of its lines",
    sql: `SELECT i.tenant_id, i.number AS detail FROM invoices i
            JOIN (SELECT invoice_id, sum(taxable_paise) t, sum(cgst_paise) c, sum(igst_paise) g, sum(total_paise) tot FROM invoice_items l WHERE ($1::uuid[] IS NULL OR l.tenant_id = ANY($1::uuid[])) GROUP BY invoice_id) l ON l.invoice_id = i.id
           WHERE ($1::uuid[] IS NULL OR i.tenant_id = ANY($1::uuid[])) AND (l.t <> i.taxable_paise OR l.c <> i.cgst_paise OR l.g <> i.igst_paise OR l.tot <> i.total_paise)`,
  },
  {
    name: "bill_without_lines",
    explain: "a bill has no lines",
    sql: `SELECT i.tenant_id, i.number AS detail FROM invoices i WHERE ($1::uuid[] IS NULL OR i.tenant_id = ANY($1::uuid[])) AND NOT EXISTS (SELECT 1 FROM invoice_items l WHERE l.invoice_id = i.id)`,
  },
  {
    name: "bill_vs_payments",
    explain: "money received on a bill differs from what the bill says was paid (a voided bill must net to zero)",
    sql: `SELECT i.tenant_id, i.number || ' (' || i.status || ')' AS detail FROM invoices i
            LEFT JOIN (SELECT invoice_id, sum(amount_paise) FILTER (WHERE kind = 'sale') sale, sum(amount_paise) FILTER (WHERE method <> 'exchange') net_money
                         FROM invoice_payments p WHERE ($1::uuid[] IS NULL OR p.tenant_id = ANY($1::uuid[])) GROUP BY invoice_id) p ON p.invoice_id = i.id
           WHERE ($1::uuid[] IS NULL OR i.tenant_id = ANY($1::uuid[])) AND (coalesce(p.sale, 0) <> i.paid_paise OR (i.status = 'voided' AND coalesce(p.net_money, 0) <> 0))`,
  },
  {
    name: "bill_line_vs_stock",
    explain: "a bill line did not take its quantity out of stock exactly once",
    sql: `SELECT l.tenant_id, i.number || ' line ' || l.line_number AS detail FROM invoice_items l JOIN invoices i ON i.id = l.invoice_id
            LEFT JOIN (SELECT source_line_id, sum(quantity) q, count(*) n FROM stock_movements m WHERE m.source_type = 'invoice' AND ($1::uuid[] IS NULL OR m.tenant_id = ANY($1::uuid[])) GROUP BY source_line_id) m ON m.source_line_id = l.id
           WHERE ($1::uuid[] IS NULL OR l.tenant_id = ANY($1::uuid[])) AND (coalesce(m.q, 0) <> -l.quantity OR coalesce(m.n, 0) <> 1)`,
  },
  {
    name: "voided_bill_vs_stock",
    explain: "a voided bill's stock was not put back exactly",
    sql: `SELECT l.tenant_id, i.number || ' line ' || l.line_number AS detail FROM invoice_items l JOIN invoices i ON i.id = l.invoice_id
            LEFT JOIN (SELECT source_line_id, sum(quantity) q FROM stock_movements m WHERE m.source_type IN ('invoice', 'invoice_void') AND ($1::uuid[] IS NULL OR m.tenant_id = ANY($1::uuid[])) GROUP BY source_line_id) m ON m.source_line_id = l.id
           WHERE ($1::uuid[] IS NULL OR l.tenant_id = ANY($1::uuid[])) AND i.status = 'voided' AND coalesce(m.q, 0) <> 0`,
  },
  {
    name: "credit_sale_vs_ledger",
    explain: "a bill sold on credit is not on the customer's account for exactly that amount",
    sql: `SELECT i.tenant_id, i.number AS detail FROM invoices i
            LEFT JOIN (SELECT source_id, sum(amount_paise) a FROM party_ledger_entries e WHERE e.source_type = 'invoice' AND e.entry_type = 'invoice' AND ($1::uuid[] IS NULL OR e.tenant_id = ANY($1::uuid[])) GROUP BY source_id) e ON e.source_id = i.id
           WHERE ($1::uuid[] IS NULL OR i.tenant_id = ANY($1::uuid[])) AND i.credit_paise > 0 AND coalesce(e.a, 0) <> i.credit_paise`,
  },
  {
    name: "credit_note_vs_lines",
    explain: "a credit note's totals differ from the sum of its lines",
    sql: `SELECT c.tenant_id, c.number AS detail FROM credit_notes c
            JOIN (SELECT credit_note_id, sum(taxable_paise) t, sum(cgst_paise) g1, sum(igst_paise) g2, sum(total_paise) tot FROM credit_note_items l WHERE ($1::uuid[] IS NULL OR l.tenant_id = ANY($1::uuid[])) GROUP BY credit_note_id) l ON l.credit_note_id = c.id
           WHERE ($1::uuid[] IS NULL OR c.tenant_id = ANY($1::uuid[])) AND (l.t <> c.taxable_paise OR l.g1 <> c.cgst_paise OR l.g2 <> c.igst_paise OR l.tot <> c.total_paise)`,
  },
  {
    name: "return_vs_stock",
    explain: "a resellable returned line did not come back into stock exactly (or a damaged one did)",
    sql: `SELECT l.tenant_id, c.number || ' line ' || l.line_number AS detail FROM credit_note_items l JOIN credit_notes c ON c.id = l.credit_note_id
            LEFT JOIN (SELECT source_line_id, sum(quantity) q FROM stock_movements m WHERE m.source_type = 'credit_note' AND ($1::uuid[] IS NULL OR m.tenant_id = ANY($1::uuid[])) GROUP BY source_line_id) m ON m.source_line_id = l.id
           WHERE ($1::uuid[] IS NULL OR l.tenant_id = ANY($1::uuid[])) AND coalesce(m.q, 0) <> CASE WHEN l.resellable THEN l.quantity ELSE 0 END`,
  },
  {
    name: "returned_more_than_sold",
    explain: "more was returned than sold on a bill line",
    sql: `SELECT l.tenant_id, i.number || ' line ' || l.line_number AS detail FROM invoice_items l JOIN invoices i ON i.id = l.invoice_id
            JOIN (SELECT invoice_item_id, sum(quantity) q FROM credit_note_items r WHERE ($1::uuid[] IS NULL OR r.tenant_id = ANY($1::uuid[])) GROUP BY invoice_item_id) r ON r.invoice_item_id = l.id
           WHERE ($1::uuid[] IS NULL OR l.tenant_id = ANY($1::uuid[])) AND r.q > l.quantity`,
  },
  {
    name: "customer_payment_vs_ledger",
    explain: "a customer payment is not on the customer's account",
    sql: `SELECT p.tenant_id, p.id::text AS detail FROM customer_payments p
           WHERE ($1::uuid[] IS NULL OR p.tenant_id = ANY($1::uuid[])) AND NOT EXISTS (SELECT 1 FROM party_ledger_entries e WHERE e.tenant_id = p.tenant_id AND e.source_type = 'customer_payment' AND e.source_id = p.id AND e.amount_paise = -p.amount_paise)`,
  },
];

const SUMMARY_SQL = `SELECT t.id AS tenant_id, t.name AS business,
    (SELECT count(*)::int FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'posted' AND i.invoice_date = $1::date) AS bills,
    (SELECT coalesce(sum(i.payable_paise), 0)::bigint FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'posted' AND i.invoice_date = $1::date) AS sales,
    (SELECT coalesce(sum(p.amount_paise), 0)::bigint FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.tenant_id = t.id AND i.invoice_date = $1::date AND p.method <> 'exchange') AS received,
    (SELECT coalesce(sum(c.refund_paise), 0)::bigint FROM credit_notes c WHERE c.tenant_id = t.id AND c.credit_note_date = $1::date) AS returns
  FROM tenants t WHERE ($2::uuid[] IS NULL OR t.id = ANY($2::uuid[])) ORDER BY t.name`;

// `onlyTenants`: limit the report to these businesses (tests; a shared test
// database also holds hand-made rows).
export async function reconcile(client: pg.Client, day: string, onlyTenants?: readonly string[]): Promise<{ mismatches: Mismatch[]; summary: DaySummary[]; checks: number }> {
  const filter = onlyTenants === undefined ? null : [...onlyTenants];
  await client.query("BEGIN TRANSACTION READ ONLY");
  try {
    const names = new Map((await client.query<{ id: string; name: string }>("SELECT id, name FROM tenants")).rows.map((r) => [r.id, r.name]));
    const mismatches: Mismatch[] = [];
    for (const check of CHECKS) {
      for (const row of (await client.query<{ tenant_id: string; detail: string }>(check.sql, [filter])).rows) {
        mismatches.push({ check: check.name, tenantId: row.tenant_id, business: names.get(row.tenant_id) ?? "?", detail: `${check.explain}: ${row.detail}` });
      }
    }
    // Stock balances equal the replay of every movement (rule 7.3), per
    // business.
    const moves = (
      await client.query<ReplayMovement & { tenant_id: string }>(
        `SELECT tenant_id, variant_id AS "variantId", branch_id AS "branchId", movement_type AS "movementType", quantity::text AS quantity, unit_cost_paise::text AS "unitCostPaise", seq::int AS seq
           FROM stock_movements WHERE ($1::uuid[] IS NULL OR tenant_id = ANY($1::uuid[])) ORDER BY seq`,
        [filter],
      )
    ).rows;
    const balances = (
      await client.query<StoredBalance & { tenant_id: string }>(
        `SELECT tenant_id, variant_id AS "variantId", branch_id AS "branchId", quantity::text AS quantity, average_cost_paise::text AS "averageCostPaise"
           FROM stock_balances WHERE ($1::uuid[] IS NULL OR tenant_id = ANY($1::uuid[]))`,
        [filter],
      )
    ).rows;
    const byTenant = <T extends { tenant_id: string }>(rows: T[]): Map<string, T[]> => {
      const map = new Map<string, T[]>();
      for (const row of rows) map.set(row.tenant_id, [...(map.get(row.tenant_id) ?? []), row]);
      return map;
    };
    const movesOf = byTenant(moves);
    const balancesOf = byTenant(balances);
    for (const tenantId of new Set([...movesOf.keys(), ...balancesOf.keys()])) {
      const differences = compare(replay(movesOf.get(tenantId) ?? []), balancesOf.get(tenantId) ?? []);
      for (const d of differences) {
        mismatches.push({ check: "stock_balance_vs_movements", tenantId, business: names.get(tenantId) ?? "?", detail: `stock ${d.problem} for an item: expected ${d.expected}, found ${d.found}` });
      }
    }
    const summary = (await client.query<{ tenant_id: string; business: string; bills: number; sales: string; received: string; returns: string }>(SUMMARY_SQL, [day, filter])).rows.map((r) => ({
      tenantId: r.tenant_id,
      business: r.business,
      bills: r.bills,
      salesPaise: Number(r.sales),
      receivedPaise: Number(r.received),
      returnsPaise: Number(r.returns),
    }));
    await client.query("COMMIT");
    return { mismatches, summary, checks: CHECKS.length + 1 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
