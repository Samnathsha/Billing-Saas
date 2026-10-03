import "server-only";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { auditLogs, files, memberships, products, roles } from "@/db/schema";

export interface FileRow {
  id: string;
  purpose: string;
  productId: string | null;
  storageKey: string;
  contentType: string;
  archivedAt: Date | null;
  version: number;
}

const cols = {
  id: files.id,
  purpose: files.purpose,
  productId: files.productId,
  storageKey: files.storageKey,
  contentType: files.contentType,
  archivedAt: files.archivedAt,
  version: files.version,
};

export async function productExists(tx: TenantTx, productId: string): Promise<boolean> {
  return (await tx.select({ id: products.id }).from(products).where(eq(products.id, productId))).length > 0;
}

export async function insertFile(
  tx: TenantTx,
  ctx: TenantContext,
  values: { purpose: "logo" | "product_image"; productId: string | null; storageKey: string; sizeBytes: number; width: number; height: number; sha256: string },
): Promise<string> {
  const [row] = await tx
    .insert(files)
    .values({ tenantId: ctx.tenantId, contentType: "image/webp", createdBy: ctx.userId, ...values })
    .returning({ id: files.id });
  if (row === undefined) throw new Error("file insert returned nothing");
  return row.id;
}

export async function getFileRow(tx: TenantTx, id: string): Promise<FileRow | undefined> {
  const [row] = await tx.select(cols).from(files).where(eq(files.id, id));
  return row;
}

export async function lockFileRow(tx: TenantTx, id: string): Promise<FileRow | undefined> {
  const [row] = await tx.select(cols).from(files).where(eq(files.id, id)).for("update");
  return row;
}

export async function activeLogos(tx: TenantTx): Promise<FileRow[]> {
  return tx.select(cols).from(files).where(and(eq(files.purpose, "logo"), isNull(files.archivedAt))).orderBy(asc(files.createdAt));
}

export async function activeProductImages(tx: TenantTx, productId: string): Promise<FileRow[]> {
  return tx
    .select(cols)
    .from(files)
    .where(and(eq(files.productId, productId), isNull(files.archivedAt)))
    .orderBy(asc(files.createdAt), asc(files.id));
}

export async function countProductImages(tx: TenantTx, productId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(files).where(and(eq(files.productId, productId), isNull(files.archivedAt)));
  return row?.n ?? 0;
}

export async function archiveFile(tx: TenantTx, row: FileRow): Promise<void> {
  await tx.update(files).set({ archivedAt: new Date(), version: row.version + 1 }).where(eq(files.id, row.id));
}

export async function addAuditEntry(
  tx: TenantTx,
  ctx: TenantContext,
  entry: { action: string; entityId: string; before: object | null; after: object | null },
): Promise<void> {
  const [role] = await tx
    .select({ name: roles.name })
    .from(memberships)
    .innerJoin(roles, and(eq(roles.tenantId, memberships.tenantId), eq(roles.id, memberships.roleId)))
    .where(eq(memberships.userId, ctx.userId));
  await tx.insert(auditLogs).values({ tenantId: ctx.tenantId, actorUserId: ctx.userId, actorRole: role?.name ?? "unknown", entityType: "file", ...entry });
}
