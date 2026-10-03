import type pg from "pg";
import { z } from "zod";
import { compare, replay, type ReplayMovement, type Running, type StockDifference, type StoredBalance } from "./stock-replay";

// Reads one business's stock ledger and balances in ONE read-only snapshot
// (so a sale saved meanwhile cannot cause a false alarm) and replays it.
// Connects as app_user: row-level security limits it to that business.

const PAGE = 5000;

export interface StockCheckResult {
  movements: number;
  balances: number;
  differences: StockDifference[];
}

export async function checkTenantStock(client: pg.ClientBase, rawTenantId: string): Promise<StockCheckResult> {
  const tenantId = z.uuid().parse(rawTenantId);
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const state = new Map<string, Running>();
    let movements = 0;
    let lastSeq = 0;
    for (;;) {
      // int8 arrives as text from pg.
      const page = await client.query<Omit<ReplayMovement, "seq"> & { seq: string }>(
        `SELECT variant_id AS "variantId", branch_id AS "branchId", movement_type AS "movementType",
                quantity::text AS quantity, unit_cost_paise::text AS "unitCostPaise", seq
           FROM stock_movements WHERE seq > $1 ORDER BY seq LIMIT $2`,
        [lastSeq, PAGE],
      );
      const rows = page.rows.map((r) => ({ ...r, seq: Number(r.seq) }));
      replay(rows, state);
      movements += rows.length;
      const last = rows.at(-1);
      if (last === undefined || rows.length < PAGE) break;
      lastSeq = last.seq;
    }
    const balances = await client.query<StoredBalance>(
      `SELECT variant_id AS "variantId", branch_id AS "branchId", quantity::text AS quantity, average_cost_paise::text AS "averageCostPaise"
         FROM stock_balances`,
    );
    await client.query("COMMIT");
    return { movements, balances: balances.rows.length, differences: compare(state, balances.rows) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
