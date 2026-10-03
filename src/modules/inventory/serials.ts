import "server-only";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { InventoryError } from "./errors";
import * as repo from "./repo";
import { postMovements, StockError } from "./stock";

// Inside-the-transaction helpers for other modules' services (purchases now,
// sales later). Like postMovements, they run only inside withTenant (a
// TenantTx exists nowhere else) after the caller checked permissions.

// Records IMEI/serial numbers arriving in a branch and returns their ids, in
// the same order. A number is refused if it is already recorded, unless its
// purchase was voided: then the same physical unit is being entered again.
export async function receiveSerials(
  tx: TenantTx,
  ctx: TenantContext,
  input: { variantId: string; branchId: string; serials: string[]; purchaseItemId?: string },
): Promise<string[]> {
  const upper = input.serials.map((x) => x.toUpperCase());
  const repeated = input.serials.filter((_, i) => upper.indexOf(upper[i] ?? "") !== i);
  if (repeated.length > 0) throw new InventoryError("SERIAL_TAKEN", repeated.join(", "));
  const existing = new Map((await repo.lockSerials(tx, input.serials)).map((r) => [r.serial.toUpperCase(), r]));
  const taken = input.serials.filter((x) => {
    const row = existing.get(x.toUpperCase());
    return row !== undefined && row.status !== "voided";
  });
  if (taken.length > 0) throw new InventoryError("SERIAL_TAKEN", taken.join(", "));

  const ids: string[] = [];
  for (const serial of input.serials) {
    const values = { variantId: input.variantId, branchId: input.branchId, purchaseItemId: input.purchaseItemId ?? null };
    const row = existing.get(serial.toUpperCase());
    ids.push(row === undefined ? await repo.insertSerial(tx, ctx, { ...values, serial }) : await repo.reactivateSerial(tx, row, values));
  }
  return ids;
}

// Undoes every stock movement of one document (a purchase now, a sale
// later) with VOID_REVERSAL movements at the original costs. Stock that came
// in must still be there, or the whole reversal is refused (business rules
// 14); a reversal is posted at most once (database unique key).
export async function reverseStockOf(
  tx: TenantTx,
  ctx: TenantContext,
  source: { sourceType: string; sourceId: string; reversalSourceType: string; note?: string },
): Promise<void> {
  const original = await repo.movementsOfSource(tx, source.sourceType, source.sourceId);
  for (const m of original) {
    if (m.serialNumberId === null) continue;
    const serial = await repo.lockSerialById(tx, m.serialNumberId);
    const incoming = !m.quantity.startsWith("-");
    if (incoming) {
      if (serial?.status !== "in_stock" || serial.branchId !== m.branchId) throw new StockError("INSUFFICIENT_STOCK", m.variantId);
      await repo.setSerialStatus(tx, serial, "voided");
    } else {
      if (serial?.status !== "sold") throw new Error("reverseStockOf: serial is not sold");
      await repo.setSerialStatus(tx, serial, "in_stock");
    }
  }
  await postMovements(
    tx,
    ctx,
    original.map((m) => ({
      branchId: m.branchId,
      variantId: m.variantId,
      type: "VOID_REVERSAL" as const,
      quantity: m.quantity.startsWith("-") ? m.quantity.slice(1) : `-${m.quantity}`,
      unitCostPaise: m.unitCostPaise,
      ...(source.note !== undefined ? { note: source.note } : {}),
      sourceType: source.reversalSourceType,
      sourceId: source.sourceId,
      sourceLineId: m.sourceLineId,
      ...(m.serialNumberId !== null ? { serialNumberId: m.serialNumberId } : {}),
    })),
  );
}
