import "server-only";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { auditLogs, branches, creditNotes, devices, idempotencyKeys, invoices, memberships, roles, settings, syncFlags, syncOperations } from "@/db/schema";

export async function claimKey(tx: TenantTx, ctx: TenantContext, key: string, operation: string, result: object): Promise<boolean> {
  const rows = await tx
    .insert(idempotencyKeys)
    .values({ tenantId: ctx.tenantId, key, operation, result })
    .onConflictDoNothing({ target: [idempotencyKeys.tenantId, idempotencyKeys.key] })
    .returning({ id: idempotencyKeys.id });
  return rows.length > 0;
}

export async function findKey(tx: TenantTx, key: string) {
  const [row] = await tx
    .select({ operation: idempotencyKeys.operation, result: idempotencyKeys.result })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.key, key)));
  return row;
}

// --- Tills (decision 0006) -------------------------------------------------

export async function businessPrefixes(tx: TenantTx): Promise<string[]> {
  const [row] = await tx.select({ invoicePrefix: settings.invoicePrefix, creditNotePrefix: settings.creditNotePrefix }).from(settings);
  return row === undefined ? [] : [row.invoicePrefix, row.creditNotePrefix];
}

export async function tillPrefixes(tx: TenantTx): Promise<string[]> {
  const rows = await tx.select({ prefix: devices.prefix }).from(devices).where(isNotNull(devices.prefix));
  return rows.flatMap((r) => (r.prefix === null ? [] : [r.prefix]));
}

export async function openBranch(tx: TenantTx, branchId: string): Promise<{ id: string; name: string } | undefined> {
  const [row] = await tx
    .select({ id: branches.id, name: branches.name, archivedAt: branches.archivedAt })
    .from(branches)
    .where(eq(branches.id, branchId));
  return row === undefined || row.archivedAt !== null ? undefined : { id: row.id, name: row.name };
}

export async function insertTill(tx: TenantTx, ctx: TenantContext, values: { branchId: string; name: string; prefix: string; tokenHash: string }): Promise<string> {
  const [row] = await tx
    .insert(devices)
    .values({ ...values, tenantId: ctx.tenantId, createdBy: ctx.userId })
    .returning({ id: devices.id });
  if (row === undefined) throw new Error("till not created");
  return row.id;
}

const tillColumns = {
  id: devices.id,
  name: devices.name,
  branchId: devices.branchId,
  branchName: branches.name,
  prefix: devices.prefix,
  status: devices.status,
  lastSeenAt: devices.lastSeenAt,
  createdAt: devices.createdAt,
  revokedAt: devices.revokedAt,
};

// Registered tills only (older device rows have no prefix).
export async function listTills(tx: TenantTx) {
  return tx
    .select(tillColumns)
    .from(devices)
    .innerJoin(branches, and(eq(branches.tenantId, devices.tenantId), eq(branches.id, devices.branchId)))
    .where(isNotNull(devices.prefix))
    .orderBy(asc(devices.status), asc(devices.name));
}

export async function lockTill(tx: TenantTx, id: string) {
  const [row] = await tx.select({ id: devices.id, name: devices.name, prefix: devices.prefix, status: devices.status }).from(devices).where(eq(devices.id, id)).for("update");
  return row;
}

// The till a token belongs to, locked: one till's operations are applied one
// at a time, in the order they arrive.
export async function lockTillByTokenHash(tx: TenantTx, tokenHash: string) {
  const [row] = await tx
    .select(tillColumns)
    .from(devices)
    .innerJoin(branches, and(eq(branches.tenantId, devices.tenantId), eq(branches.id, devices.branchId)))
    .where(eq(devices.tokenHash, tokenHash))
    .for("update", { of: devices });
  return row;
}

export async function revokeTill(tx: TenantTx, ctx: TenantContext, id: string): Promise<void> {
  await tx
    .update(devices)
    .set({ status: "revoked", revokedAt: new Date(), revokedBy: ctx.userId, updatedAt: new Date(), version: sql`${devices.version} + 1` })
    .where(eq(devices.id, id));
}

export async function touchTill(tx: TenantTx, id: string): Promise<void> {
  await tx.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, id));
}

export async function offlineWindowHours(tx: TenantTx): Promise<number> {
  const [row] = await tx.select({ hours: settings.offlineWindowHours }).from(settings);
  return row?.hours ?? 72;
}

export async function setOfflineWindowHours(tx: TenantTx, hours: number): Promise<void> {
  await tx.update(settings).set({ offlineWindowHours: hours, updatedAt: new Date(), version: sql`${settings.version} + 1` });
}

// --- Synced operations ------------------------------------------------------

export async function claimOperation(
  tx: TenantTx,
  ctx: TenantContext,
  values: { deviceId: string; clientOpId: string; operation: string; status: "applied" | "flagged"; result: object },
): Promise<boolean> {
  const rows = await tx
    .insert(syncOperations)
    .values({ ...values, tenantId: ctx.tenantId })
    .onConflictDoNothing({ target: [syncOperations.tenantId, syncOperations.deviceId, syncOperations.clientOpId] })
    .returning({ id: syncOperations.id });
  return rows.length > 0;
}

export async function findOperation(tx: TenantTx, deviceId: string, clientOpId: string) {
  const [row] = await tx
    .select({ operation: syncOperations.operation, status: syncOperations.status, result: syncOperations.result })
    .from(syncOperations)
    .where(and(eq(syncOperations.deviceId, deviceId), eq(syncOperations.clientOpId, clientOpId)));
  return row;
}

// --- Flags -----------------------------------------------------------------

export type NewFlag = { deviceId: string; invoiceId: string | null; creditNoteId: string | null; code: string; detail: object };

export async function insertFlags(tx: TenantTx, ctx: TenantContext, flags: NewFlag[]): Promise<void> {
  if (flags.length > 0) await tx.insert(syncFlags).values(flags.map((f) => ({ ...f, tenantId: ctx.tenantId })));
}

export async function listFlags(tx: TenantTx, status: "open" | "resolved", limit: number) {
  return tx
    .select({
      id: syncFlags.id,
      code: syncFlags.code,
      detail: syncFlags.detail,
      status: syncFlags.status,
      createdAt: syncFlags.createdAt,
      resolvedAt: syncFlags.resolvedAt,
      resolutionNote: syncFlags.resolutionNote,
      tillName: devices.name,
      invoiceId: syncFlags.invoiceId,
      invoiceNumber: invoices.number,
      creditNoteId: syncFlags.creditNoteId,
      creditNoteNumber: creditNotes.number,
    })
    .from(syncFlags)
    .innerJoin(devices, and(eq(devices.tenantId, syncFlags.tenantId), eq(devices.id, syncFlags.deviceId)))
    .leftJoin(invoices, and(eq(invoices.tenantId, syncFlags.tenantId), eq(invoices.id, syncFlags.invoiceId)))
    .leftJoin(creditNotes, and(eq(creditNotes.tenantId, syncFlags.tenantId), eq(creditNotes.id, syncFlags.creditNoteId)))
    .where(eq(syncFlags.status, status))
    .orderBy(status === "open" ? asc(syncFlags.createdAt) : desc(syncFlags.resolvedAt))
    .limit(limit);
}

export async function countOpenFlags(tx: TenantTx): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(syncFlags).where(eq(syncFlags.status, "open"));
  return row?.n ?? 0;
}

export async function lockFlag(tx: TenantTx, id: string) {
  const [row] = await tx.select({ id: syncFlags.id, status: syncFlags.status, code: syncFlags.code }).from(syncFlags).where(eq(syncFlags.id, id)).for("update");
  return row;
}

export async function resolveFlag(tx: TenantTx, ctx: TenantContext, id: string, note: string): Promise<void> {
  await tx.update(syncFlags).set({ status: "resolved", resolvedAt: new Date(), resolvedBy: ctx.userId, resolutionNote: note }).where(eq(syncFlags.id, id));
}

// --- Audit -----------------------------------------------------------------

export async function addAuditEntry(
  tx: TenantTx,
  ctx: TenantContext,
  entry: { action: string; entityType: string; entityId: string; before: object | null; after: object | null; deviceId?: string },
): Promise<void> {
  const [role] = await tx
    .select({ name: roles.name })
    .from(memberships)
    .innerJoin(roles, and(eq(roles.tenantId, memberships.tenantId), eq(roles.id, memberships.roleId)))
    .where(eq(memberships.userId, ctx.userId));
  await tx.insert(auditLogs).values({ tenantId: ctx.tenantId, actorUserId: ctx.userId, actorRole: role?.name ?? "unknown", ...entry });
}
