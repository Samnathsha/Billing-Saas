import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { TenantTx } from "@/db/with-tenant";

// Report queries (blueprint Phase 9). Every total is computed by the
// database (GROUP BY / window functions over indexed columns), never by
// loading all rows into memory. Row-level security limits every query to
// the business of the transaction. Money comes back as whole paise; sums of
// cost (4 decimals of a paisa) are rounded to the paisa once, at the end.

type Row = Record<string, unknown>;

async function rows<T>(tx: TenantTx, query: SQL): Promise<T[]> {
  const result = await tx.execute(query);
  return result.rows as T[];
}

const n = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

export async function businessTimeZone(tx: TenantTx): Promise<string> {
  const [row] = await rows<{ time_zone: string }>(tx, sql`SELECT time_zone FROM settings LIMIT 1`);
  return row?.time_zone ?? "Asia/Kolkata";
}

export async function salesTotals(tx: TenantTx, from: string, to: string) {
  const [bills] = await rows<Row>(
    tx,
    sql`SELECT count(*) FILTER (WHERE status = 'posted') AS bills,
               count(*) FILTER (WHERE status = 'voided') AS voided,
               coalesce(sum(payable_paise) FILTER (WHERE status = 'posted'), 0) AS payable,
               coalesce(sum(taxable_paise) FILTER (WHERE status = 'posted'), 0) AS taxable,
               coalesce(sum(tax_paise) FILTER (WHERE status = 'posted'), 0) AS tax,
               coalesce(sum(discount_paise) FILTER (WHERE status = 'posted'), 0) AS discount,
               coalesce(sum(credit_paise) FILTER (WHERE status = 'posted'), 0) AS on_credit
          FROM invoices WHERE invoice_date BETWEEN ${from} AND ${to}`,
  );
  const [returns] = await rows<Row>(
    tx,
    sql`SELECT count(*) AS notes, coalesce(sum(refund_paise), 0) AS refund,
               coalesce(sum(taxable_paise), 0) AS taxable, coalesce(sum(tax_paise), 0) AS tax
          FROM credit_notes WHERE credit_note_date BETWEEN ${from} AND ${to}`,
  );
  return {
    bills: n(bills?.bills),
    voided: n(bills?.voided),
    payablePaise: n(bills?.payable),
    taxablePaise: n(bills?.taxable),
    taxPaise: n(bills?.tax),
    discountPaise: n(bills?.discount),
    onCreditPaise: n(bills?.on_credit),
    creditNotes: n(returns?.notes),
    returnsPaise: n(returns?.refund),
    returnsTaxablePaise: n(returns?.taxable),
    returnsTaxPaise: n(returns?.tax),
  };
}

export async function salesByDay(tx: TenantTx, from: string, to: string) {
  const bills = await rows<Row>(
    tx,
    sql`SELECT invoice_date::text AS day, count(*) AS bills, sum(payable_paise) AS payable, sum(taxable_paise) AS taxable, sum(tax_paise) AS tax
          FROM invoices WHERE status = 'posted' AND invoice_date BETWEEN ${from} AND ${to}
         GROUP BY invoice_date`,
  );
  const returns = await rows<Row>(
    tx,
    sql`SELECT credit_note_date::text AS day, sum(refund_paise) AS refund
          FROM credit_notes WHERE credit_note_date BETWEEN ${from} AND ${to}
         GROUP BY credit_note_date`,
  );
  return { bills, returns };
}

// What was sold, grouped by `key` (item, category or staff member), with
// returns of the same group in the same dates.
export async function salesGrouped(tx: TenantTx, from: string, to: string, by: "item" | "category" | "user") {
  const soldKey =
    by === "item"
      ? sql`ii.variant_id::text AS key, min(ii.product_name) AS name, min(ii.variant_label) AS label, min(ii.sku) AS sku`
      : by === "category"
        ? sql`coalesce(c.id::text, 'none') AS key, coalesce(min(c.name), 'No category') AS name, '' AS label, '' AS sku`
        : sql`i.created_by::text AS key, coalesce(min(u.display_name), 'Unknown') AS name, '' AS label, '' AS sku`;
  const soldGroup = by === "item" ? sql`ii.variant_id` : by === "category" ? sql`c.id` : sql`i.created_by`;
  const sold = await rows<Row>(
    tx,
    sql`SELECT ${soldKey}, sum(ii.quantity)::text AS quantity, sum(ii.taxable_paise) AS taxable, sum(ii.total_paise) AS total, count(DISTINCT i.id) AS bills
          FROM invoice_items ii
          JOIN invoices i ON i.tenant_id = ii.tenant_id AND i.id = ii.invoice_id
          JOIN product_variants pv ON pv.tenant_id = ii.tenant_id AND pv.id = ii.variant_id
          JOIN products p ON p.tenant_id = pv.tenant_id AND p.id = pv.product_id
          LEFT JOIN categories c ON c.tenant_id = p.tenant_id AND c.id = p.category_id
          LEFT JOIN users u ON u.id = i.created_by
         WHERE i.status = 'posted' AND i.invoice_date BETWEEN ${from} AND ${to}
         GROUP BY ${soldGroup}
         ORDER BY sum(ii.total_paise) DESC
         LIMIT 500`,
  );
  const returnKey = by === "item" ? sql`cni.variant_id::text` : by === "category" ? sql`coalesce(c.id::text, 'none')` : sql`cn.created_by::text`;
  const returned = await rows<Row>(
    tx,
    sql`SELECT ${returnKey} AS key, sum(cni.quantity)::text AS quantity, sum(cni.total_paise) AS total
          FROM credit_note_items cni
          JOIN credit_notes cn ON cn.tenant_id = cni.tenant_id AND cn.id = cni.credit_note_id
          JOIN product_variants pv ON pv.tenant_id = cni.tenant_id AND pv.id = cni.variant_id
          JOIN products p ON p.tenant_id = pv.tenant_id AND p.id = pv.product_id
          LEFT JOIN categories c ON c.tenant_id = p.tenant_id AND c.id = p.category_id
         WHERE cn.credit_note_date BETWEEN ${from} AND ${to}
         GROUP BY 1`,
  );
  return { sold, returned };
}

// Money in and out by method. Bill payments count on the bill's date (a
// same-day void adds negative rows); exchange credit is not money.
export async function paymentsByMethod(tx: TenantTx, from: string, to: string) {
  const bills = await rows<Row>(
    tx,
    sql`SELECT ip.method, sum(ip.amount_paise) AS amount
          FROM invoice_payments ip JOIN invoices i ON i.tenant_id = ip.tenant_id AND i.id = ip.invoice_id
         WHERE i.invoice_date BETWEEN ${from} AND ${to} AND ip.method <> 'exchange'
         GROUP BY ip.method`,
  );
  const customers = await rows<Row>(
    tx,
    sql`SELECT method, sum(amount_paise) AS amount FROM customer_payments WHERE received_on BETWEEN ${from} AND ${to} GROUP BY method`,
  );
  const refunds = await rows<Row>(
    tx,
    sql`SELECT refund_method AS method, sum(refund_paise - exchange_paise) AS amount
          FROM credit_notes
         WHERE credit_note_date BETWEEN ${from} AND ${to} AND refund_method IN ('cash', 'upi', 'card')
         GROUP BY refund_method`,
  );
  const expenses = await rows<Row>(
    tx,
    sql`SELECT method, sum(amount_paise) AS amount FROM expenses WHERE status = 'posted' AND paid_on BETWEEN ${from} AND ${to} GROUP BY method`,
  );
  return { bills, customers, refunds, expenses };
}

export async function profit(tx: TenantTx, from: string, to: string) {
  const [row] = await rows<Row>(
    tx,
    sql`SELECT
          (SELECT coalesce(sum(taxable_paise), 0) FROM invoices WHERE status = 'posted' AND invoice_date BETWEEN ${from} AND ${to}) AS sales_taxable,
          (SELECT coalesce(sum(taxable_paise), 0) FROM credit_notes WHERE credit_note_date BETWEEN ${from} AND ${to}) AS returns_taxable,
          (SELECT coalesce(round(sum(ii.unit_cost_paise * ii.quantity)), 0)
             FROM invoice_items ii JOIN invoices i ON i.tenant_id = ii.tenant_id AND i.id = ii.invoice_id
            WHERE i.status = 'posted' AND i.invoice_date BETWEEN ${from} AND ${to}) AS cost_sold,
          (SELECT coalesce(round(sum(ii.unit_cost_paise * cni.quantity)), 0)
             FROM credit_note_items cni
             JOIN credit_notes cn ON cn.tenant_id = cni.tenant_id AND cn.id = cni.credit_note_id
             JOIN invoice_items ii ON ii.tenant_id = cni.tenant_id AND ii.id = cni.invoice_item_id
            WHERE cni.resellable AND cn.credit_note_date BETWEEN ${from} AND ${to}) AS cost_returned,
          (SELECT coalesce(sum(amount_paise), 0) FROM expenses WHERE status = 'posted' AND paid_on BETWEEN ${from} AND ${to}) AS expenses`,
  );
  return {
    salesTaxablePaise: n(row?.sales_taxable),
    returnsTaxablePaise: n(row?.returns_taxable),
    costSoldPaise: n(row?.cost_sold),
    costReturnedPaise: n(row?.cost_returned),
    expensesPaise: n(row?.expenses),
  };
}

export async function stockValue(tx: TenantTx) {
  return rows<Row>(
    tx,
    sql`SELECT b.id AS branch_id, b.name AS branch, coalesce(sum(sb.quantity), 0)::text AS quantity,
               coalesce(round(sum(sb.quantity * sb.average_cost_paise)), 0) AS value
          FROM branches b LEFT JOIN stock_balances sb ON sb.tenant_id = b.tenant_id AND sb.branch_id = b.id
         GROUP BY b.id, b.name ORDER BY b.name`,
  );
}

// Items at or below their reorder level in an open branch (only items with
// a reorder level set).
export async function lowStock(tx: TenantTx) {
  return rows<Row>(
    tx,
    sql`SELECT pv.id AS variant_id, p.name AS product, pv.attributes, pv.sku, b.name AS branch,
               coalesce(sb.quantity, 0)::text AS quantity, pv.reorder_level::text AS reorder_level
          FROM product_variants pv
          JOIN products p ON p.tenant_id = pv.tenant_id AND p.id = pv.product_id
          JOIN branches b ON b.tenant_id = pv.tenant_id AND b.archived_at IS NULL
          LEFT JOIN stock_balances sb ON sb.tenant_id = pv.tenant_id AND sb.variant_id = pv.id AND sb.branch_id = b.id
         WHERE pv.archived_at IS NULL AND p.archived_at IS NULL AND pv.reorder_level > 0
           AND coalesce(sb.quantity, 0) <= pv.reorder_level
         ORDER BY coalesce(sb.quantity, 0) / pv.reorder_level, p.name
         LIMIT 200`,
  );
}

// What each customer owes (or each supplier is owed), split by how long it
// has been owed. Payments and credits pay the oldest amounts first (FIFO),
// worked out with running totals in the database.
export async function ageing(tx: TenantTx, party: "customer" | "supplier", asOf: string, timeZone: string) {
  const column = sql.identifier(party === "customer" ? "customer_id" : "supplier_id");
  const names = party === "customer" ? sql`customers` : sql`suppliers`;
  return rows<Row>(
    tx,
    sql`WITH e AS (
          SELECT ${column} AS party, amount_paise AS amount, created_at, id
            FROM party_ledger_entries WHERE ${column} IS NOT NULL
        ),
        totals AS (
          SELECT party, sum(amount) AS balance, coalesce(-sum(amount) FILTER (WHERE amount < 0), 0) AS credits FROM e GROUP BY party
        ),
        debits AS (
          SELECT party, amount, (created_at AT TIME ZONE ${timeZone})::date AS day,
                 sum(amount) OVER (PARTITION BY party ORDER BY created_at, id) AS running
            FROM e WHERE amount > 0
        ),
        open AS (
          SELECT d.party, d.day, greatest(0, least(d.amount, d.running - t.credits)) AS open
            FROM debits d JOIN totals t ON t.party = d.party
        )
        SELECT t.party::text AS party, x.name, t.balance,
               coalesce(sum(o.open) FILTER (WHERE ${asOf}::date - o.day <= 30), 0) AS d0_30,
               coalesce(sum(o.open) FILTER (WHERE ${asOf}::date - o.day BETWEEN 31 AND 60), 0) AS d31_60,
               coalesce(sum(o.open) FILTER (WHERE ${asOf}::date - o.day BETWEEN 61 AND 90), 0) AS d61_90,
               coalesce(sum(o.open) FILTER (WHERE ${asOf}::date - o.day > 90), 0) AS d90
          FROM totals t
          JOIN ${names} x ON x.id = t.party
          LEFT JOIN open o ON o.party = t.party
         WHERE t.balance <> 0
         GROUP BY t.party, x.name, t.balance
         ORDER BY t.balance DESC
         LIMIT 500`,
  );
}

export async function taxSummary(tx: TenantTx, from: string, to: string) {
  const output = await rows<Row>(
    tx,
    sql`SELECT ii.tax_rate::text AS rate, sum(ii.taxable_paise) AS taxable, sum(ii.cgst_paise) AS cgst, sum(ii.sgst_paise) AS sgst, sum(ii.igst_paise) AS igst
          FROM invoice_items ii JOIN invoices i ON i.tenant_id = ii.tenant_id AND i.id = ii.invoice_id
         WHERE i.status = 'posted' AND i.invoice_date BETWEEN ${from} AND ${to}
         GROUP BY ii.tax_rate ORDER BY ii.tax_rate`,
  );
  const outputReturns = await rows<Row>(
    tx,
    sql`SELECT ii.tax_rate::text AS rate, sum(cni.taxable_paise) AS taxable, sum(cni.cgst_paise) AS cgst, sum(cni.sgst_paise) AS sgst, sum(cni.igst_paise) AS igst
          FROM credit_note_items cni
          JOIN credit_notes cn ON cn.tenant_id = cni.tenant_id AND cn.id = cni.credit_note_id
          JOIN invoice_items ii ON ii.tenant_id = cni.tenant_id AND ii.id = cni.invoice_item_id
         WHERE cn.credit_note_date BETWEEN ${from} AND ${to}
         GROUP BY ii.tax_rate`,
  );
  // GST paid on purchases counts as input tax only where the purchase was
  // recorded by a registered business (cost without GST).
  const input = await rows<Row>(
    tx,
    sql`SELECT pi.tax_rate::text AS rate, sum(pi.line_subtotal_paise) AS taxable, sum(pi.line_tax_paise) AS tax
          FROM purchase_items pi JOIN purchases p ON p.tenant_id = pi.tenant_id AND p.id = pi.purchase_id
         WHERE p.status = 'posted' AND p.cost_basis = 'excludes_tax' AND p.invoice_date BETWEEN ${from} AND ${to}
         GROUP BY pi.tax_rate ORDER BY pi.tax_rate`,
  );
  const inputReturns = await rows<Row>(
    tx,
    sql`SELECT pi.tax_rate::text AS rate, sum(pri.subtotal_paise) AS taxable, sum(pri.tax_paise) AS tax
          FROM purchase_return_items pri
          JOIN purchase_returns pr ON pr.tenant_id = pri.tenant_id AND pr.id = pri.purchase_return_id
          JOIN purchase_items pi ON pi.tenant_id = pri.tenant_id AND pi.id = pri.purchase_item_id
          JOIN purchases p ON p.tenant_id = pi.tenant_id AND p.id = pi.purchase_id
         WHERE p.cost_basis = 'excludes_tax' AND pr.return_date BETWEEN ${from} AND ${to}
         GROUP BY pi.tax_rate`,
  );
  return { output, outputReturns, input, inputReturns };
}

// From the start of `from` to the end of `to`, as days in the business's
// time zone.
export async function auditEntries(tx: TenantTx, filter: { from: string; to: string; timeZone: string; action: string | null; offset: number }) {
  const action = filter.action === null ? sql`TRUE` : sql`a.action LIKE ${`${filter.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`;
  return rows<Row>(
    tx,
    sql`SELECT a.id, a.created_at, a.actor_role, coalesce(u.display_name, 'System') AS actor, a.action, a.entity_type, a.entity_id::text AS entity_id,
               a.before::text AS before, a.after::text AS after
          FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE a.created_at >= (${filter.from}::date::timestamp AT TIME ZONE ${filter.timeZone})
           AND a.created_at < ((${filter.to}::date + 1)::timestamp AT TIME ZONE ${filter.timeZone})
           AND ${action}
         ORDER BY a.created_at DESC, a.id
         LIMIT 101 OFFSET ${filter.offset}`,
  );
}
