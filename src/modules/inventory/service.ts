import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { hasPermission, requirePermission, type Permission } from "@/modules/auth";
import { claimIdempotencyKey } from "@/modules/sync";
import * as repo from "./repo";
import { postMovements, type MovementInput } from "./stock";

// Opening stock and stock adjustments (blueprint Phase 6; business rules 7,
// 13, 14). Both need "Stock adjustment", carry an idempotency key, run in
// one transaction and are audited. All stock changes go through
// postMovements.

const QTY_POSITIVE = /^\d{1,11}(\.\d{1,3})?$/;
const SERIAL = /^[A-Za-z0-9-]{4,40}$/;
const VIEW: readonly Permission[] = ["products.manage", "sales.create", "reports.view", "stock.adjust", "purchases.create"];

export type InventoryErrorCode = "ALREADY_HAS_STOCK_HISTORY" | "SERIAL_COUNT" | "SERIAL_TAKEN" | "SERIAL_NOT_IN_STOCK" | "ZERO_QUANTITY";

const MESSAGES: Record<InventoryErrorCode, string> = {
  ALREADY_HAS_STOCK_HISTORY: "This item already has stock history in this branch. Use a stock adjustment instead.",
  SERIAL_COUNT: "Enter one IMEI/serial number per unit.",
  SERIAL_TAKEN: "This IMEI/serial number is already recorded.",
  SERIAL_NOT_IN_STOCK: "This IMEI/serial number is not in stock in this branch.",
  ZERO_QUANTITY: "Enter a quantity above zero.",
};

export class InventoryError extends Error {
  constructor(
    public readonly code: InventoryErrorCode,
    public readonly detail?: string,
  ) {
    super(detail === undefined ? MESSAGES[code] : `${MESSAGES[code]} (${detail})`);
    this.name = "InventoryError";
  }
}

const quantity = z.string().trim().regex(QTY_POSITIVE, { error: "Enter a quantity (at most 3 decimals)." });
const serials = z.array(z.string().trim().regex(SERIAL, { error: "IMEI/serial: 4 to 40 letters, digits or -" })).max(500).default([]);

export const openingStockInput = z.strictObject({
  idempotencyKey: z.uuid(),
  branchId: z.uuid(),
  lines: z
    .array(
      z.strictObject({
        variantId: z.uuid(),
        quantity,
        // Paise per unit; empty = the variant's starting cost (rule 13).
        unitCostPaise: z.int().min(0).max(1_000_000_000).nullable().optional(),
        serials,
      }),
    )
    .min(1)
    .max(500),
});

export const adjustStockInput = z.strictObject({
  idempotencyKey: z.uuid(),
  branchId: z.uuid(),
  variantId: z.uuid(),
  direction: z.enum(["in", "out"]),
  quantity,
  reasonCode: z.enum(["damaged", "lost", "found", "count_correction", "expired", "other"]),
  note: z.string().trim().max(500).optional(),
  serial: z.string().trim().regex(SERIAL).optional(),
});

export async function recordOpeningStock(ctx: TenantContext, rawInput: unknown): Promise<{ operationId: string }> {
  await requirePermission(ctx, "stock.adjust");
  const input = openingStockInput.parse(rawInput);
  const operationId = randomUUID();
  return withTenant(ctx, async (tx) => {
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "stock.opening", { operationId });
    if (!claim.claimed) return claim.result;

    const costs = await repo.variantStartingCosts(tx, input.lines.map((l) => l.variantId));
    const movements: MovementInput[] = [];
    for (const line of input.lines) {
      if (Number(line.quantity) <= 0) throw new InventoryError("ZERO_QUANTITY");
      if (await repo.hasMovements(tx, line.variantId, input.branchId)) throw new InventoryError("ALREADY_HAS_STOCK_HISTORY");
      const unitCostPaise = String(line.unitCostPaise ?? costs.get(line.variantId) ?? 0);
      const lineId = randomUUID();
      if (line.serials.length > 0) {
        if (line.serials.length !== Number(line.quantity)) throw new InventoryError("SERIAL_COUNT");
        const taken = await repo.existingSerials(tx, line.serials);
        const repeated = line.serials.map((x) => x.toUpperCase()).filter((x, i, all) => all.indexOf(x) !== i);
        if (taken.length > 0 || repeated.length > 0) throw new InventoryError("SERIAL_TAKEN", [...taken, ...repeated].join(", "));
        for (const serial of line.serials) {
          const serialNumberId = await repo.insertSerial(tx, ctx, { variantId: line.variantId, serial, branchId: input.branchId });
          movements.push({ branchId: input.branchId, variantId: line.variantId, type: "OPENING_STOCK", quantity: "1", unitCostPaise, sourceType: "opening_stock", sourceId: operationId, sourceLineId: lineId, serialNumberId });
        }
      } else {
        movements.push({ branchId: input.branchId, variantId: line.variantId, type: "OPENING_STOCK", quantity: line.quantity, unitCostPaise, sourceType: "opening_stock", sourceId: operationId, sourceLineId: lineId });
      }
    }
    await postMovements(tx, ctx, movements);
    await repo.addAuditEntry(tx, ctx, { action: "stock.opening_recorded", entityType: "stock", entityId: operationId, before: null, after: { branchId: input.branchId, lines: input.lines } });
    return { operationId };
  });
}

export async function adjustStock(ctx: TenantContext, rawInput: unknown): Promise<{ operationId: string }> {
  await requirePermission(ctx, "stock.adjust");
  const input = adjustStockInput.parse(rawInput);
  if (Number(input.quantity) <= 0) throw new InventoryError("ZERO_QUANTITY");
  const operationId = randomUUID();
  return withTenant(ctx, async (tx) => {
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "stock.adjust", { operationId });
    if (!claim.claimed) return claim.result;

    let serialNumberId: string | undefined;
    if (input.serial !== undefined) {
      if (input.direction === "in") {
        if ((await repo.existingSerials(tx, [input.serial])).length > 0) throw new InventoryError("SERIAL_TAKEN", input.serial);
        serialNumberId = await repo.insertSerial(tx, ctx, { variantId: input.variantId, serial: input.serial, branchId: input.branchId });
      } else {
        const row = await repo.lockSerial(tx, input.serial);
        if (row === undefined || row.status !== "in_stock" || row.branchId !== input.branchId || row.variantId !== input.variantId) {
          throw new InventoryError("SERIAL_NOT_IN_STOCK", input.serial);
        }
        await repo.setSerialStatus(tx, row, "scrapped");
        serialNumberId = row.id;
      }
    }
    await postMovements(tx, ctx, [
      {
        branchId: input.branchId,
        variantId: input.variantId,
        type: input.direction === "in" ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
        quantity: input.direction === "in" ? input.quantity : `-${input.quantity}`,
        reasonCode: input.reasonCode,
        ...(input.note !== undefined && input.note !== "" ? { note: input.note } : {}),
        sourceType: "adjustment",
        sourceId: operationId,
        sourceLineId: operationId,
        ...(serialNumberId !== undefined ? { serialNumberId } : {}),
      },
    ]);
    await repo.addAuditEntry(tx, ctx, { action: "stock.adjusted", entityType: "stock", entityId: operationId, before: null, after: { ...input } });
    return { operationId };
  });
}

export interface StockLevelDto {
  variantId: string;
  branchId: string;
  quantity: string;
  // Only for "View cost price and profit".
  averageCostPaise?: string;
}

export async function getStockLevels(ctx: TenantContext, rawInput: unknown): Promise<StockLevelDto[]> {
  await requirePermission(ctx, VIEW);
  const { variantIds } = z.strictObject({ variantIds: z.array(z.uuid()).max(500) }).parse(rawInput);
  const showCost = await hasPermission(ctx, "costs.view");
  const rows = await withTenant(ctx, (tx) => repo.balancesOf(tx, variantIds));
  return rows.map((r) => ({
    variantId: r.variantId,
    branchId: r.branchId,
    quantity: r.quantity,
    ...(showCost ? { averageCostPaise: r.averageCostPaise } : {}),
  }));
}

