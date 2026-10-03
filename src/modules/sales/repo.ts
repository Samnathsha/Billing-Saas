import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { auditLogs, invoiceItems, invoicePayments, invoices, memberships, roles, serialNumbers, settings, tenants } from "@/db/schema";

// Database queries of the sales module, inside the caller's transaction.

// Creates the series at 1, or adds 1 while below `max`. The row stays
// locked until the transaction ends. undefined = the series is full.
export async function incrementSequence(
  tx: TenantTx,
  ctx: TenantContext,
  series: { kind: string; prefix: string; financialYear: string },
  max: number,
): Promise<number | undefined> {
  const result = await tx.execute<{ last_number: number }>(sql`
    INSERT INTO invoice_sequences (tenant_id, series, prefix, financial_year, last_number, created_by)
    VALUES (${ctx.tenantId}, ${series.kind}, ${series.prefix}, ${series.financialYear}, 1, ${ctx.userId})
    ON CONFLICT (tenant_id, series, prefix, financial_year)
    DO UPDATE SET last_number = invoice_sequences.last_number + 1,
                  version = invoice_sequences.version + 1,
                  updated_at = now()
    WHERE invoice_sequences.last_number < ${max}
    RETURNING last_number`);
  return result.rows[0]?.last_number;
}

// The settings a sale depends on. FOR SHARE: settings cannot change (e.g.
// the bill prefix) while a sale is being saved; sales do not block each
// other.
export async function saleSettings(tx: TenantTx) {
  const [row] = await tx
    .select({
      businessName: tenants.name,
      stateCode: settings.stateCode,
      gstRegistration: settings.gstRegistration,
      gstin: settings.gstin,
      pricesIncludeTax: settings.pricesIncludeTax,
      cashierDiscountLimitBps: settings.cashierDiscountLimitBps,
      invoicePrefix: settings.invoicePrefix,
      timeZone: settings.timeZone,
      financialYearStartMonth: settings.financialYearStartMonth,
    })
    .from(settings)
    .innerJoin(tenants, eq(tenants.id, settings.tenantId))
    .for("share", { of: settings });
  return row;
}

export type InvoiceRow = typeof invoices.$inferInsert;
export type InvoiceItemRow = typeof invoiceItems.$inferInsert;
export type InvoicePaymentRow = typeof invoicePayments.$inferInsert;

export async function insertInvoice(tx: TenantTx, ctx: TenantContext, values: Omit<InvoiceRow, "tenantId" | "createdBy">): Promise<void> {
  await tx.insert(invoices).values({ ...values, tenantId: ctx.tenantId, createdBy: ctx.userId });
}

export async function insertItems(tx: TenantTx, ctx: TenantContext, items: Omit<InvoiceItemRow, "tenantId">[]): Promise<void> {
  if (items.length > 0) await tx.insert(invoiceItems).values(items.map((i) => ({ ...i, tenantId: ctx.tenantId })));
}

export async function insertPayments(tx: TenantTx, ctx: TenantContext, payments: Omit<InvoicePaymentRow, "tenantId" | "createdBy">[]): Promise<void> {
  if (payments.length > 0) await tx.insert(invoicePayments).values(payments.map((p) => ({ ...p, tenantId: ctx.tenantId, createdBy: ctx.userId })));
}

export async function findInvoice(tx: TenantTx, id: string) {
  const [row] = await tx.select().from(invoices).where(eq(invoices.id, id));
  return row;
}

export async function lockInvoice(tx: TenantTx, id: string) {
  const [row] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
  return row;
}

export async function itemsOf(tx: TenantTx, invoiceId: string) {
  return tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId)).orderBy(invoiceItems.lineNumber);
}

export async function paymentsOf(tx: TenantTx, invoiceId: string) {
  return tx.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, invoiceId)).orderBy(invoicePayments.createdAt, invoicePayments.id);
}

export async function markVoided(tx: TenantTx, ctx: TenantContext, id: string, reason: string): Promise<void> {
  await tx.update(invoices).set({ status: "voided", voidReason: reason, voidedAt: new Date(), voidedBy: ctx.userId }).where(eq(invoices.id, id));
}

export async function listInvoices(tx: TenantTx, filter: { day: string | null; customerId: string | null }) {
  const conditions = [];
  if (filter.day !== null) conditions.push(eq(invoices.invoiceDate, filter.day));
  if (filter.customerId !== null) conditions.push(eq(invoices.customerId, filter.customerId));
  return tx
    .select({
      id: invoices.id,
      number: invoices.number,
      invoiceDate: invoices.invoiceDate,
      status: invoices.status,
      buyerName: invoices.buyerName,
      payablePaise: invoices.payablePaise,
      paidPaise: invoices.paidPaise,
      creditPaise: invoices.creditPaise,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .where(and(...conditions))
    .orderBy(desc(invoices.createdAt), desc(invoices.sequenceNumber))
    .limit(200);
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

export async function serialTexts(tx: TenantTx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ id: serialNumbers.id, serial: serialNumbers.serial }).from(serialNumbers).where(inArray(serialNumbers.id, ids));
  return new Map(rows.map((r) => [r.id, r.serial]));
}
