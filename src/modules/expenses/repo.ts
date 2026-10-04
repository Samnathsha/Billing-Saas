import "server-only";
import { and, asc, between, desc, eq, sql } from "drizzle-orm";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { auditLogs, expenseCategories, expenses, memberships, roles, settings } from "@/db/schema";

// Database queries of the expenses module, inside the caller's transaction.

export async function timeZone(tx: TenantTx): Promise<string> {
  const [row] = await tx.select({ timeZone: settings.timeZone }).from(settings);
  return row?.timeZone ?? "Asia/Kolkata";
}

export async function listCategories(tx: TenantTx) {
  return tx
    .select({ id: expenseCategories.id, name: expenseCategories.name, archivedAt: expenseCategories.archivedAt, version: expenseCategories.version })
    .from(expenseCategories)
    .orderBy(asc(sql`lower(${expenseCategories.name})`));
}

export async function categoryNameTaken(tx: TenantTx, name: string): Promise<boolean> {
  const rows = await tx.select({ id: expenseCategories.id }).from(expenseCategories).where(sql`lower(${expenseCategories.name}) = lower(${name})`);
  return rows.length > 0;
}

export async function insertCategory(tx: TenantTx, ctx: TenantContext, name: string): Promise<string> {
  const [row] = await tx.insert(expenseCategories).values({ tenantId: ctx.tenantId, name, createdBy: ctx.userId }).returning({ id: expenseCategories.id });
  if (row === undefined) throw new Error("category insert returned nothing");
  return row.id;
}

export async function lockCategory(tx: TenantTx, id: string) {
  const [row] = await tx
    .select({ id: expenseCategories.id, name: expenseCategories.name, archivedAt: expenseCategories.archivedAt, version: expenseCategories.version })
    .from(expenseCategories)
    .where(eq(expenseCategories.id, id))
    .for("update");
  return row;
}

export async function setCategoryArchived(tx: TenantTx, row: { id: string; version: number }, archived: boolean): Promise<void> {
  await tx
    .update(expenseCategories)
    .set({ archivedAt: archived ? new Date() : null, version: row.version + 1 })
    .where(eq(expenseCategories.id, row.id));
}

export async function insertExpense(tx: TenantTx, ctx: TenantContext, values: Omit<typeof expenses.$inferInsert, "tenantId" | "createdBy">): Promise<void> {
  await tx.insert(expenses).values({ ...values, tenantId: ctx.tenantId, createdBy: ctx.userId });
}

export async function lockExpense(tx: TenantTx, id: string) {
  const [row] = await tx.select({ id: expenses.id, status: expenses.status, amountPaise: expenses.amountPaise }).from(expenses).where(eq(expenses.id, id)).for("update");
  return row;
}

export async function markVoided(tx: TenantTx, ctx: TenantContext, id: string, reason: string): Promise<void> {
  await tx.update(expenses).set({ status: "voided", voidReason: reason, voidedAt: new Date(), voidedBy: ctx.userId }).where(eq(expenses.id, id));
}

export async function listExpenses(tx: TenantTx, from: string, to: string) {
  return tx
    .select({
      id: expenses.id,
      paidOn: expenses.paidOn,
      categoryId: expenses.categoryId,
      categoryName: expenseCategories.name,
      amountPaise: expenses.amountPaise,
      method: expenses.method,
      description: expenses.description,
      reference: expenses.reference,
      status: expenses.status,
      voidReason: expenses.voidReason,
      createdAt: expenses.createdAt,
    })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .where(and(between(expenses.paidOn, from, to)))
    .orderBy(desc(expenses.paidOn), desc(expenses.createdAt))
    .limit(1000);
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
