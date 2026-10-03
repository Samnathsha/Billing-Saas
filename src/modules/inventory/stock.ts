import "server-only";
import { z } from "zod";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import * as repo from "./repo";
import type { MovementType } from "./schema";

// THE only way stock changes (blueprint Phase 6). Callers are services that
// already checked permissions and opened the transaction (a TenantTx only
// exists inside withTenant). Rules:
// - balances are locked in a fixed order (variant, then branch) so two
//   operations can never deadlock;
// - stock out succeeds only if enough remains (never below zero online,
//   rule 7.1), as one statement on the locked row;
// - stock in updates the weighted average cost (rule 7.3) in the
//   database's exact decimals; each movement stores its unit cost;
// - whole-piece units take whole quantities; IMEI items move one unit at a
//   time with their serial number;
// - the same source line cannot be posted twice (database unique key).

const QTY = /^-?\d{1,11}(\.\d{1,3})?$/;
const COST = /^\d{1,14}(\.\d{1,4})?$/;

export const movementInput = z.strictObject({
  branchId: z.uuid(),
  variantId: z.uuid(),
  type: z.enum([
    "PURCHASE_IN",
    "SALE_OUT",
    "SALE_RETURN_IN",
    "PURCHASE_RETURN_OUT",
    "ADJUSTMENT_IN",
    "ADJUSTMENT_OUT",
    "TRANSFER_IN",
    "TRANSFER_OUT",
    "OPENING_STOCK",
    "VOID_REVERSAL",
  ]),
  // Signed decimal text, e.g. "5", "-1", "2.5".
  quantity: z.string().regex(QTY),
  // Required when stock comes in (or a reversal at a known cost).
  unitCostPaise: z.string().regex(COST).optional(),
  reasonCode: z.enum(["damaged", "lost", "found", "count_correction", "expired", "other"]).optional(),
  note: z.string().max(500).optional(),
  sourceType: z.string().regex(/^[a-z_]{1,40}$/),
  sourceId: z.uuid(),
  sourceLineId: z.uuid(),
  serialNumberId: z.uuid().optional(),
});
export type MovementInput = z.input<typeof movementInput>;

export type StockErrorCode =
  | "INSUFFICIENT_STOCK"
  | "WHOLE_UNITS_ONLY"
  | "SERIAL_REQUIRED"
  | "SERIAL_NOT_ALLOWED"
  | "VARIANT_NOT_FOUND"
  | "BRANCH_CLOSED"
  | "ALREADY_POSTED"
  | "COST_REQUIRED";

const MESSAGES: Record<StockErrorCode, string> = {
  INSUFFICIENT_STOCK: "Not enough stock.",
  WHOLE_UNITS_ONLY: "This item is counted in whole pieces.",
  SERIAL_REQUIRED: "This item is tracked by IMEI/serial: one unit at a time, with its number.",
  SERIAL_NOT_ALLOWED: "This item is not tracked by IMEI/serial.",
  VARIANT_NOT_FOUND: "Item not found.",
  BRANCH_CLOSED: "This branch is closed.",
  ALREADY_POSTED: "This was already recorded.",
  COST_REQUIRED: "A cost is needed for stock coming in.",
};

export class StockError extends Error {
  constructor(
    public readonly code: StockErrorCode,
    public readonly variantId?: string,
  ) {
    super(MESSAGES[code]);
    this.name = "StockError";
  }
}

const ADDS_AT_COST: ReadonlySet<MovementType> = new Set(["PURCHASE_IN", "OPENING_STOCK", "SALE_RETURN_IN", "TRANSFER_IN", "ADJUSTMENT_IN"]);

export async function postMovements(tx: TenantTx, ctx: TenantContext, rawInputs: MovementInput[]): Promise<string[]> {
  const inputs = rawInputs.map((m) => movementInput.parse(m));
  const facts = new Map((await repo.variantFacts(tx, [...new Set(inputs.map((m) => m.variantId))])).map((f) => [f.variantId, f]));
  const open = await repo.openBranchIds(tx, [...new Set(inputs.map((m) => m.branchId))]);

  for (const m of inputs) {
    const fact = facts.get(m.variantId);
    if (fact === undefined) throw new StockError("VARIANT_NOT_FOUND", m.variantId);
    if (!open.has(m.branchId)) throw new StockError("BRANCH_CLOSED");
    if (!fact.allowsFraction && m.quantity.includes(".") && !/\.0+$/.test(m.quantity)) throw new StockError("WHOLE_UNITS_ONLY", m.variantId);
    if (fact.trackSerial && (m.serialNumberId === undefined || !/^-?1(\.0+)?$/.test(m.quantity))) {
      throw new StockError("SERIAL_REQUIRED", m.variantId);
    }
    if (!fact.trackSerial && m.serialNumberId !== undefined) throw new StockError("SERIAL_NOT_ALLOWED", m.variantId);
    const incoming = !m.quantity.startsWith("-");
    if (incoming && m.type !== "VOID_REVERSAL" && !ADDS_AT_COST.has(m.type)) throw new Error("postMovements: sign does not fit the type");
    if ((incoming || m.type === "VOID_REVERSAL") && m.unitCostPaise === undefined && m.type !== "ADJUSTMENT_IN") {
      throw new StockError("COST_REQUIRED", m.variantId);
    }
  }

  // Lock every balance first, in a fixed order.
  const keys = [...new Set(inputs.map((m) => `${m.variantId}|${m.branchId}`))].sort();
  const balances = new Map<string, Awaited<ReturnType<typeof repo.lockBalance>>>();
  for (const key of keys) {
    const [variantId = "", branchId = ""] = key.split("|");
    balances.set(key, await repo.lockBalance(tx, ctx, variantId, branchId));
  }

  const ids: string[] = [];
  for (const m of inputs) {
    const balance = balances.get(`${m.variantId}|${m.branchId}`);
    if (balance === undefined) throw new Error("balance not locked");
    const incoming = !m.quantity.startsWith("-");
    // Found stock comes in at the current average cost.
    const unitCost = m.unitCostPaise ?? balance.averageCostPaise;
    const ok =
      incoming || m.type === "VOID_REVERSAL"
        ? await repo.addAtCost(tx, balance.id, m.quantity, unitCost)
        : await repo.takeOut(tx, balance.id, m.quantity);
    if (!ok) throw new StockError("INSUFFICIENT_STOCK", m.variantId);
    try {
      ids.push(
        await repo.insertMovement(tx, ctx, {
          branchId: m.branchId,
          variantId: m.variantId,
          movementType: m.type,
          quantity: m.quantity,
          // Stock out records the average cost at that moment (rule 7.3).
          unitCostPaise: incoming || m.type === "VOID_REVERSAL" ? unitCost : balance.averageCostPaise,
          reasonCode: m.reasonCode ?? null,
          note: m.note ?? null,
          sourceType: m.sourceType,
          sourceId: m.sourceId,
          sourceLineId: m.sourceLineId,
          serialNumberId: m.serialNumberId ?? null,
        }),
      );
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      if (cause instanceof Error && "code" in cause && cause.code === "23505") throw new StockError("ALREADY_POSTED");
      throw error;
    }
    // Later movements of the same item see the updated cost.
    const [updated] = await repo.balancesOf(tx, [m.variantId]).then((rows) => rows.filter((r) => r.branchId === m.branchId));
    if (updated !== undefined) balances.set(`${m.variantId}|${m.branchId}`, { ...balance, quantity: updated.quantity, averageCostPaise: updated.averageCostPaise });
  }
  return ids;
}
