import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { auditLogs, brands, categories, memberships, roles, units } from "@/db/schema";

// Database queries of the catalog module, inside the caller's withTenant
// transaction (row-level security limits them to the business).

export type ListKind = "category" | "brand" | "unit";

const tableOf = { category: categories, brand: brands, unit: units } as const;

export async function listCategories(tx: TenantTx) {
  return tx
    .select({ id: categories.id, name: categories.name, parentId: categories.parentId, archivedAt: categories.archivedAt })
    .from(categories)
    .orderBy(asc(categories.name));
}

export async function listBrands(tx: TenantTx) {
  return tx.select({ id: brands.id, name: brands.name, archivedAt: brands.archivedAt }).from(brands).orderBy(asc(brands.name));
}

export async function listUnits(tx: TenantTx) {
  return tx
    .select({ id: units.id, name: units.name, code: units.code, allowsFraction: units.allowsFraction, archivedAt: units.archivedAt })
    .from(units)
    .orderBy(asc(units.name));
}

// Any item of this kind (open or archived) already using the name, ignoring
// case.
export async function nameTaken(tx: TenantTx, kind: ListKind, name: string, exceptId: string | null): Promise<boolean> {
  const table = tableOf[kind];
  const rows = await tx.select({ id: table.id }).from(table).where(sql`lower(${table.name}) = lower(${name})`);
  return rows.some((r) => r.id !== exceptId);
}

export async function unitCodeTaken(tx: TenantTx, code: string): Promise<boolean> {
  const rows = await tx.select({ id: units.id }).from(units).where(sql`lower(${units.code}) = lower(${code})`);
  return rows.length > 0;
}

export async function lockItem(
  tx: TenantTx,
  kind: ListKind,
  id: string,
): Promise<{ id: string; name: string; archivedAt: Date | null; version: number } | undefined> {
  const table = tableOf[kind];
  const [row] = await tx
    .select({ id: table.id, name: table.name, archivedAt: table.archivedAt, version: table.version })
    .from(table)
    .where(eq(table.id, id))
    .for("update");
  return row;
}

export async function findCategory(tx: TenantTx, id: string) {
  const [row] = await tx
    .select({ id: categories.id, parentId: categories.parentId, archivedAt: categories.archivedAt })
    .from(categories)
    .where(eq(categories.id, id));
  return row;
}

export async function insertCategory(tx: TenantTx, ctx: TenantContext, name: string, parentId: string | null): Promise<string> {
  const [row] = await tx
    .insert(categories)
    .values({ tenantId: ctx.tenantId, name, parentId, createdBy: ctx.userId })
    .returning({ id: categories.id });
  if (row === undefined) throw new Error("category insert returned nothing");
  return row.id;
}

export async function insertBrand(tx: TenantTx, ctx: TenantContext, name: string): Promise<string> {
  const [row] = await tx.insert(brands).values({ tenantId: ctx.tenantId, name, createdBy: ctx.userId }).returning({ id: brands.id });
  if (row === undefined) throw new Error("brand insert returned nothing");
  return row.id;
}

export async function insertUnit(
  tx: TenantTx,
  ctx: TenantContext,
  values: { name: string; code: string; allowsFraction: boolean },
): Promise<string> {
  const [row] = await tx.insert(units).values({ tenantId: ctx.tenantId, createdBy: ctx.userId, ...values }).returning({ id: units.id });
  if (row === undefined) throw new Error("unit insert returned nothing");
  return row.id;
}

export async function updateItem(
  tx: TenantTx,
  kind: ListKind,
  item: { id: string; version: number },
  values: { name?: string; archivedAt?: Date | null },
): Promise<void> {
  const table = tableOf[kind];
  await tx
    .update(table)
    .set({ ...values, version: item.version + 1 })
    .where(eq(table.id, item.id));
}

export async function actorRoleName(tx: TenantTx, ctx: TenantContext): Promise<string> {
  const [row] = await tx
    .select({ name: roles.name })
    .from(memberships)
    .innerJoin(roles, and(eq(roles.tenantId, memberships.tenantId), eq(roles.id, memberships.roleId)))
    .where(eq(memberships.userId, ctx.userId));
  return row?.name ?? "unknown";
}

export async function addAuditEntry(
  tx: TenantTx,
  ctx: TenantContext,
  entry: { action: string; entityType: string; entityId: string; before: object | null; after: object | null },
): Promise<void> {
  await tx
    .insert(auditLogs)
    .values({ tenantId: ctx.tenantId, actorUserId: ctx.userId, actorRole: await actorRoleName(tx, ctx), ...entry });
}
