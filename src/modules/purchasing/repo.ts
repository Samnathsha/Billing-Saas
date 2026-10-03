import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { auditLogs, memberships, purchaseItems, purchases, roles, settings, supplierPayments, suppliers } from "@/db/schema";

// Database queries of the purchasing module, inside the caller's transaction.

export async function businessFacts(tx: TenantTx): Promise<{ gstRegistration: string | null; timeZone: string }> {
  const [row] = await tx.select({ gstRegistration: settings.gstRegistration, timeZone: settings.timeZone }).from(settings);
  if (row === undefined) throw new Error("business settings missing");
  return row;
}

export async function billNumberTaken(tx: TenantTx, supplierId: string, number: string): Promise<boolean> {
  const rows = await tx
    .select({ id: purchases.id })
    .from(purchases)
    .where(and(eq(purchases.supplierId, supplierId), eq(purchases.status, "posted"), sql`upper(${purchases.supplierInvoiceNumber}) = upper(${number})`))
    .limit(1);
  return rows.length > 0;
}

export type PurchaseRow = typeof purchases.$inferInsert;
export type PurchaseItemRow = typeof purchaseItems.$inferInsert;

export async function insertPurchase(tx: TenantTx, ctx: TenantContext, values: Omit<PurchaseRow, "tenantId" | "createdBy">): Promise<void> {
  await tx.insert(purchases).values({ ...values, tenantId: ctx.tenantId, createdBy: ctx.userId });
}

export async function insertItems(tx: TenantTx, ctx: TenantContext, items: Omit<PurchaseItemRow, "tenantId">[]): Promise<void> {
  if (items.length === 0) return;
  await tx.insert(purchaseItems).values(items.map((i) => ({ ...i, tenantId: ctx.tenantId })));
}

export async function insertPayment(
  tx: TenantTx,
  ctx: TenantContext,
  values: { id: string; supplierId: string; purchaseId: string | null; amountPaise: number; method: string; reference: string | null; paidOn: string },
): Promise<void> {
  await tx.insert(supplierPayments).values({ ...values, tenantId: ctx.tenantId, createdBy: ctx.userId });
}

export async function lockPurchase(tx: TenantTx, id: string) {
  const [row] = await tx
    .select({ id: purchases.id, supplierId: purchases.supplierId, status: purchases.status, totalPaise: purchases.totalPaise, supplierInvoiceNumber: purchases.supplierInvoiceNumber })
    .from(purchases)
    .where(eq(purchases.id, id))
    .for("update");
  return row;
}

export async function markVoided(tx: TenantTx, ctx: TenantContext, id: string, reason: string): Promise<void> {
  await tx.update(purchases).set({ status: "voided", voidReason: reason, voidedAt: new Date(), voidedBy: ctx.userId }).where(eq(purchases.id, id));
}

const purchaseColumns = {
  id: purchases.id,
  supplierId: purchases.supplierId,
  supplierName: suppliers.name,
  branchId: purchases.branchId,
  supplierInvoiceNumber: purchases.supplierInvoiceNumber,
  invoiceDate: purchases.invoiceDate,
  status: purchases.status,
  subtotalPaise: purchases.subtotalPaise,
  taxPaise: purchases.taxPaise,
  totalPaise: purchases.totalPaise,
  costBasis: purchases.costBasis,
  note: purchases.note,
  voidReason: purchases.voidReason,
  voidedAt: purchases.voidedAt,
  createdAt: purchases.createdAt,
  paidPaise: sql<string>`coalesce((SELECT sum(p.amount_paise) FROM supplier_payments p WHERE p.purchase_id = purchases.id), 0)::text`,
};

export async function listPurchases(tx: TenantTx, filter: { supplierId: string | null }) {
  return tx
    .select(purchaseColumns)
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .where(filter.supplierId === null ? undefined : eq(purchases.supplierId, filter.supplierId))
    .orderBy(desc(purchases.invoiceDate), desc(purchases.createdAt))
    .limit(200);
}

export async function findPurchase(tx: TenantTx, id: string) {
  const [row] = await tx.select(purchaseColumns).from(purchases).innerJoin(suppliers, eq(suppliers.id, purchases.supplierId)).where(eq(purchases.id, id));
  return row;
}

export async function itemsOf(tx: TenantTx, purchaseId: string) {
  return tx
    .select({
      id: purchaseItems.id,
      lineNumber: purchaseItems.lineNumber,
      variantId: purchaseItems.variantId,
      quantity: purchaseItems.quantity,
      unitPricePaise: purchaseItems.unitPricePaise,
      taxRate: purchaseItems.taxRate,
      lineSubtotalPaise: purchaseItems.lineSubtotalPaise,
      lineTaxPaise: purchaseItems.lineTaxPaise,
      lineTotalPaise: purchaseItems.lineTotalPaise,
      unitCostPaise: purchaseItems.unitCostPaise,
    })
    .from(purchaseItems)
    .where(eq(purchaseItems.purchaseId, purchaseId))
    .orderBy(purchaseItems.lineNumber);
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
