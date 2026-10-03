import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { auditLogs, branches, memberships, products, productVariants, roles, serialNumbers, stockBalances, stockMovements } from "@/db/schema";

// Database queries of the inventory module, inside the caller's transaction.

export async function variantFacts(tx: TenantTx, variantIds: string[]) {
  if (variantIds.length === 0) return [];
  return tx
    .select({
      variantId: productVariants.id,
      trackSerial: products.trackSerial,
      allowsFraction: sql<boolean>`(SELECT u.allows_fraction FROM units u WHERE u.id = ${products.unitId})`,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, variantIds));
}

export async function openBranchIds(tx: TenantTx, branchIds: string[]): Promise<Set<string>> {
  if (branchIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(inArray(branches.id, branchIds), sql`${branches.archivedAt} IS NULL`));
  return new Set(rows.map((r) => r.id));
}

// Creates the balance row if missing, then locks it until the end of the
// transaction.
export async function lockBalance(
  tx: TenantTx,
  ctx: TenantContext,
  variantId: string,
  branchId: string,
): Promise<{ id: string; quantity: string; averageCostPaise: string }> {
  await tx
    .insert(stockBalances)
    .values({ tenantId: ctx.tenantId, variantId, branchId })
    .onConflictDoNothing({ target: [stockBalances.tenantId, stockBalances.variantId, stockBalances.branchId] });
  const [row] = await tx
    .select({ id: stockBalances.id, quantity: stockBalances.quantity, averageCostPaise: stockBalances.averageCostPaise })
    .from(stockBalances)
    .where(and(eq(stockBalances.variantId, variantId), eq(stockBalances.branchId, branchId)))
    .for("update");
  if (row === undefined) throw new Error("stock balance missing after insert");
  return row;
}

export interface MovementRow {
  branchId: string;
  variantId: string;
  movementType: string;
  quantity: string;
  unitCostPaise: string;
  reasonCode: string | null;
  note: string | null;
  sourceType: string;
  sourceId: string;
  sourceLineId: string;
  serialNumberId: string | null;
}

export async function insertMovement(tx: TenantTx, ctx: TenantContext, m: MovementRow): Promise<string> {
  const [row] = await tx
    .insert(stockMovements)
    .values({ tenantId: ctx.tenantId, createdBy: ctx.userId, ...m })
    .returning({ id: stockMovements.id });
  if (row === undefined) throw new Error("movement insert returned nothing");
  return row.id;
}

// Stock in (or a reversal at a known cost): weighted average cost, computed
// in the database's exact decimals, rounded to 4 decimal places of a paisa.
export async function addAtCost(tx: TenantTx, balanceId: string, quantity: string, unitCostPaise: string): Promise<boolean> {
  const rows = await tx.execute(sql`
    UPDATE stock_balances
       SET average_cost_paise = CASE
             WHEN quantity + ${quantity}::numeric > 0
             THEN greatest(round((quantity * average_cost_paise + ${quantity}::numeric * ${unitCostPaise}::numeric)
                                 / (quantity + ${quantity}::numeric), 4), 0)
             ELSE 0 END,
           quantity = quantity + ${quantity}::numeric,
           version = version + 1,
           updated_at = now()
     WHERE id = ${balanceId} AND quantity + ${quantity}::numeric >= 0
     RETURNING id`);
  return (rows.rowCount ?? 0) > 0;
}

// Stock out at the current average cost: succeeds only if enough remains
// (the check and the change are one statement on a locked row).
export async function takeOut(tx: TenantTx, balanceId: string, quantity: string): Promise<boolean> {
  const rows = await tx.execute(sql`
    UPDATE stock_balances
       SET quantity = quantity + ${quantity}::numeric, version = version + 1, updated_at = now()
     WHERE id = ${balanceId} AND quantity + ${quantity}::numeric >= 0
     RETURNING id`);
  return (rows.rowCount ?? 0) > 0;
}

export async function balancesOf(tx: TenantTx, variantIds: string[]) {
  if (variantIds.length === 0) return [];
  return tx
    .select({
      variantId: stockBalances.variantId,
      branchId: stockBalances.branchId,
      quantity: stockBalances.quantity,
      averageCostPaise: stockBalances.averageCostPaise,
    })
    .from(stockBalances)
    .where(inArray(stockBalances.variantId, variantIds));
}

export async function variantStartingCosts(tx: TenantTx, variantIds: string[]): Promise<Map<string, number | null>> {
  if (variantIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: productVariants.id, cost: productVariants.costPricePaise })
    .from(productVariants)
    .where(inArray(productVariants.id, variantIds));
  return new Map(rows.map((r) => [r.id, r.cost]));
}

export async function hasMovements(tx: TenantTx, variantId: string, branchId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .where(and(eq(stockMovements.variantId, variantId), eq(stockMovements.branchId, branchId)))
    .limit(1);
  return rows.length > 0;
}

// Serial numbers (IMEI), compared ignoring case.
export async function insertSerial(
  tx: TenantTx,
  ctx: TenantContext,
  values: { variantId: string; serial: string; branchId: string; purchaseItemId?: string | null },
): Promise<string> {
  const [row] = await tx
    .insert(serialNumbers)
    .values({ tenantId: ctx.tenantId, createdBy: ctx.userId, status: "in_stock", ...values })
    .returning({ id: serialNumbers.id });
  if (row === undefined) throw new Error("serial insert returned nothing");
  return row.id;
}

export async function lockSerials(tx: TenantTx, serials: string[]) {
  if (serials.length === 0) return [];
  return tx
    .select({ id: serialNumbers.id, serial: serialNumbers.serial, status: serialNumbers.status, version: serialNumbers.version })
    .from(serialNumbers)
    .where(inArray(sql`upper(${serialNumbers.serial})`, serials.map((x) => x.toUpperCase())))
    .for("update");
}

// A voided unit entered again: it takes the new item, branch and line.
export async function reactivateSerial(
  tx: TenantTx,
  row: { id: string; version: number },
  values: { variantId: string; branchId: string; purchaseItemId: string | null },
): Promise<string> {
  await tx
    .update(serialNumbers)
    .set({ ...values, status: "in_stock", version: row.version + 1 })
    .where(eq(serialNumbers.id, row.id));
  return row.id;
}

export async function lockSerialById(tx: TenantTx, id: string) {
  const [row] = await tx
    .select({ id: serialNumbers.id, branchId: serialNumbers.branchId, status: serialNumbers.status, version: serialNumbers.version })
    .from(serialNumbers)
    .where(eq(serialNumbers.id, id))
    .for("update");
  return row;
}

export async function movementsOfSource(tx: TenantTx, sourceType: string, sourceId: string) {
  return tx
    .select({
      branchId: stockMovements.branchId,
      variantId: stockMovements.variantId,
      quantity: stockMovements.quantity,
      unitCostPaise: stockMovements.unitCostPaise,
      sourceLineId: stockMovements.sourceLineId,
      serialNumberId: stockMovements.serialNumberId,
    })
    .from(stockMovements)
    .where(and(eq(stockMovements.sourceType, sourceType), eq(stockMovements.sourceId, sourceId)))
    .orderBy(stockMovements.createdAt, stockMovements.id);
}

export async function lockSerial(tx: TenantTx, serial: string) {
  const [row] = await tx
    .select({ id: serialNumbers.id, variantId: serialNumbers.variantId, branchId: serialNumbers.branchId, status: serialNumbers.status, version: serialNumbers.version })
    .from(serialNumbers)
    .where(eq(sql`upper(${serialNumbers.serial})`, serial.toUpperCase()))
    .for("update");
  return row;
}

export async function setSerialStatus(tx: TenantTx, row: { id: string; version: number }, status: "in_stock" | "sold" | "returned" | "scrapped" | "voided"): Promise<void> {
  await tx.update(serialNumbers).set({ status, version: row.version + 1 }).where(eq(serialNumbers.id, row.id));
}

export async function addAuditEntry(
  tx: TenantTx,
  ctx: TenantContext,
  entry: { action: string; entityType: string; entityId: string; before: object | null; after: object | null },
): Promise<void> {
  const [role] = await tx
    .select({ name: roles.name })
    .from(memberships)
    .innerJoin(roles, and(eq(roles.tenantId, memberships.tenantId), eq(roles.id, memberships.roleId)))
    .where(eq(memberships.userId, ctx.userId));
  await tx.insert(auditLogs).values({ tenantId: ctx.tenantId, actorUserId: ctx.userId, actorRole: role?.name ?? "unknown", ...entry });
}

export async function markSerialSold(
  tx: TenantTx,
  row: { id: string; version: number },
  values: { invoiceItemId: string; warrantyEndsOn: string | null },
): Promise<void> {
  await tx
    .update(serialNumbers)
    .set({ status: "sold", invoiceItemId: values.invoiceItemId, warrantyEndsOn: values.warrantyEndsOn, version: row.version + 1 })
    .where(eq(serialNumbers.id, row.id));
}

export async function lockSerialsWithPlace(tx: TenantTx, serials: string[]) {
  if (serials.length === 0) return [];
  return tx
    .select({
      id: serialNumbers.id,
      serial: serialNumbers.serial,
      variantId: serialNumbers.variantId,
      branchId: serialNumbers.branchId,
      status: serialNumbers.status,
      version: serialNumbers.version,
    })
    .from(serialNumbers)
    .where(inArray(sql`upper(${serialNumbers.serial})`, serials.map((x) => x.toUpperCase())))
    .for("update");
}

export async function setSerialPlace(tx: TenantTx, row: { id: string; version: number }, values: { status: "in_stock" | "scrapped"; branchId: string }): Promise<void> {
  await tx
    .update(serialNumbers)
    .set({ ...values, version: row.version + 1 })
    .where(eq(serialNumbers.id, row.id));
}
