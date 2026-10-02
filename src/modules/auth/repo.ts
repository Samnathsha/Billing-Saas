import "server-only";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { getAuthDb } from "@/db/auth-client";
import type { TenantContext, TenantTx, UserTx } from "@/db/with-tenant";
import { auditLogs, branches, memberships, rolePermissions, roles, settings, tenants } from "@/db/schema";
import { DEFAULT_ROLES, OWNER_ROLE } from "./default-roles";

// Database queries of the auth module. Everything runs inside a transaction
// handed in by the service (UserTx or TenantTx), except the session update,
// which is the login library's own table (auth_service connection).

// Serialises "create a business" per user, so a double click cannot create
// two businesses. Released automatically at the end of the transaction.
export async function lockUserForBusinessCreation(tx: UserTx, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('create-business:' || ${userId}, 0))`);
}

export async function countActiveMemberships(tx: UserTx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")));
  return row?.n ?? 0;
}

export interface NewBusiness {
  businessName: string;
  template: "clothing" | "mobile";
}

// Business, settings, first branch, default roles and permissions, the owner
// membership and the audit entry. Runs in the caller's single transaction.
export async function insertBusiness(tx: TenantTx, ctx: TenantContext, input: NewBusiness): Promise<void> {
  const { tenantId, userId } = ctx;
  await tx.insert(tenants).values({ id: tenantId, name: input.businessName, template: input.template, createdBy: userId });
  await tx.insert(settings).values({ tenantId, createdBy: userId });
  await tx.insert(branches).values({ tenantId, name: "Main branch", createdBy: userId });

  const roleIds = new Map<string, string>();
  for (const name of Object.keys(DEFAULT_ROLES)) {
    const [role] = await tx
      .insert(roles)
      .values({ tenantId, name, isSystem: true, createdBy: userId })
      .returning({ id: roles.id });
    if (role === undefined) throw new Error("role insert returned nothing");
    roleIds.set(name, role.id);
  }
  const grants = Object.entries(DEFAULT_ROLES).flatMap(([name, codes]) =>
    codes.map((permissionCode) => ({ tenantId, roleId: roleIds.get(name) ?? "", permissionCode, createdBy: userId })),
  );
  await tx.insert(rolePermissions).values(grants);

  const ownerRoleId = roleIds.get(OWNER_ROLE);
  if (ownerRoleId === undefined) throw new Error("owner role missing");
  await tx.insert(memberships).values({ tenantId, userId, roleId: ownerRoleId, createdBy: userId });

  await tx.insert(auditLogs).values({
    tenantId,
    actorUserId: userId,
    actorRole: OWNER_ROLE,
    action: "business.created",
    entityType: "tenant",
    entityId: tenantId,
    after: { name: input.businessName, template: input.template },
  });
}

// The user's active membership in an active business, if any (login view).
export async function findActiveMembership(
  tx: UserTx,
  userId: string,
  tenantId: string,
): Promise<{ roleId: string } | undefined> {
  const [row] = await tx
    .select({ roleId: memberships.roleId })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.tenantId, tenantId),
        eq(memberships.status, "active"),
        eq(tenants.status, "active"),
      ),
    );
  return row;
}

// The user's active businesses (login view), to pick one automatically.
export async function listActiveBusinessIds(tx: UserTx, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ tenantId: memberships.tenantId })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "active"), eq(tenants.status, "active")));
  return rows.map((r) => r.tenantId);
}

export async function loadRole(
  tx: TenantTx,
  roleId: string,
): Promise<{ name: string; permissions: string[] } | undefined> {
  const [role] = await tx.select({ name: roles.name }).from(roles).where(eq(roles.id, roleId));
  if (role === undefined) return undefined;
  const rows = await tx
    .select({ code: rolePermissions.permissionCode })
    .from(rolePermissions)
    .where(inArray(rolePermissions.roleId, [roleId]));
  return { name: role.name, permissions: rows.map((r) => r.code).sort() };
}

// Does this user's active membership in this (active) business carry the
// permission through its role? Read fresh on every call, never cached.
export async function memberHasPermission(tx: TenantTx, ctx: TenantContext, permission: string): Promise<boolean> {
  const [row] = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .innerJoin(
      rolePermissions,
      and(eq(rolePermissions.tenantId, memberships.tenantId), eq(rolePermissions.roleId, memberships.roleId)),
    )
    .where(
      and(
        eq(memberships.tenantId, ctx.tenantId),
        eq(memberships.userId, ctx.userId),
        eq(memberships.status, "active"),
        eq(tenants.status, "active"),
        eq(rolePermissions.permissionCode, permission),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Staff management (service.ts). Row-level security limits every query to
// the caller's business.
// ---------------------------------------------------------------------------

export interface MemberRow {
  membershipId: string;
  userId: string;
  roleId: string;
  roleName: string;
  roleIsSystem: boolean;
  status: string;
  version: number;
}

// The member's row, locked until the end of the transaction so two changes
// to the same person cannot cross.
export async function lockMember(tx: TenantTx, userId: string): Promise<MemberRow | undefined> {
  const [row] = await tx
    .select({
      membershipId: memberships.id,
      userId: memberships.userId,
      roleId: memberships.roleId,
      roleName: roles.name,
      roleIsSystem: roles.isSystem,
      status: memberships.status,
      version: memberships.version,
    })
    .from(memberships)
    .innerJoin(roles, and(eq(roles.tenantId, memberships.tenantId), eq(roles.id, memberships.roleId)))
    .where(eq(memberships.userId, userId))
    .for("update", { of: memberships });
  return row;
}

export async function memberRoleName(tx: TenantTx, userId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ name: roles.name })
    .from(memberships)
    .innerJoin(roles, and(eq(roles.tenantId, memberships.tenantId), eq(roles.id, memberships.roleId)))
    .where(eq(memberships.userId, userId));
  return row?.name;
}

export async function findRoleById(
  tx: TenantTx,
  roleId: string,
): Promise<{ id: string; name: string; isSystem: boolean } | undefined> {
  const [row] = await tx
    .select({ id: roles.id, name: roles.name, isSystem: roles.isSystem })
    .from(roles)
    .where(eq(roles.id, roleId));
  return row;
}

export async function setMemberRole(tx: TenantTx, member: MemberRow, roleId: string): Promise<void> {
  await tx
    .update(memberships)
    .set({ roleId, version: member.version + 1 })
    .where(eq(memberships.id, member.membershipId));
}

export async function disableMember(tx: TenantTx, member: MemberRow): Promise<void> {
  await tx
    .update(memberships)
    .set({ status: "disabled", version: member.version + 1 })
    .where(eq(memberships.id, member.membershipId));
}

export interface AuditEntry {
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export async function addAuditEntry(tx: TenantTx, ctx: TenantContext, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLogs).values({ tenantId: ctx.tenantId, actorUserId: ctx.userId, ...entry });
}

// Sets (or clears) the business a session works in. Only called after a
// membership check by the service.
export async function setSessionActiveTenant(sessionToken: string, tenantId: string | null): Promise<void> {
  await getAuthDb().$client.query("UPDATE sessions SET active_tenant_id = $1 WHERE token = $2", [
    tenantId,
    sessionToken,
  ]);
}

// Ends one session (e.g. past the absolute timeout).
export async function deleteSession(sessionToken: string): Promise<void> {
  await getAuthDb().$client.query("DELETE FROM sessions WHERE token = $1", [sessionToken]);
}

// The user's unexpired sessions (devices), newest use first. Never the token.
export async function listUserSessions(userId: string): Promise<
  { id: string; createdAt: Date; updatedAt: Date; ipAddress: string | null; userAgent: string | null }[]
> {
  const result = await getAuthDb().$client.query<{
    id: string;
    created_at: Date;
    updated_at: Date;
    ip_address: string | null;
    user_agent: string | null;
  }>(
    `SELECT id, created_at, updated_at, ip_address, user_agent FROM sessions
     WHERE user_id = $1 AND expires_at > now() ORDER BY updated_at DESC, id`,
    [userId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
  }));
}

// Ends one of the user's own sessions. The user_id condition means one user
// can never end another user's session, whatever id is sent.
export async function deleteUserSession(userId: string, sessionId: string): Promise<boolean> {
  const result = await getAuthDb().$client.query("DELETE FROM sessions WHERE id = $1 AND user_id = $2", [
    sessionId,
    userId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

// Ends every session of the user ("log out everywhere").
export async function deleteAllUserSessions(userId: string): Promise<number> {
  const result = await getAuthDb().$client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  return result.rowCount ?? 0;
}

// Is this user account still allowed to log in? (Read by the login library's
// role, before any business is known.)
export async function isUserActive(userId: string): Promise<boolean> {
  const result = await getAuthDb().$client.query<{ ok: boolean }>(
    "SELECT status = 'active' AS ok FROM users WHERE id = $1",
    [userId],
  );
  return result.rows[0]?.ok === true;
}

// ---------------------------------------------------------------------------
// Per-account login limit and security log (auth_service connection).
// ---------------------------------------------------------------------------

export async function getLoginFailures(key: string): Promise<{ count: number; lastRequest: number } | undefined> {
  const result = await getAuthDb().$client.query<{ count: number; last_request: string }>(
    "SELECT count, last_request FROM rate_limits WHERE key = $1",
    [key],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : { count: row.count, lastRequest: Number(row.last_request) };
}

// Adds one failure atomically (safe under parallel attempts) and returns the
// new count. A counter older than forgetAfterSeconds starts again at 1.
export async function recordLoginFailure(key: string, forgetAfterSeconds: number): Promise<number> {
  const now = Date.now();
  const result = await getAuthDb().$client.query<{ count: number }>(
    `INSERT INTO rate_limits (key, count, last_request) VALUES ($1, 1, $2)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN $2 - rate_limits.last_request >= $3 THEN 1 ELSE rate_limits.count + 1 END,
       last_request = $2
     RETURNING count`,
    [key, now, forgetAfterSeconds * 1000],
  );
  return result.rows[0]?.count ?? 1;
}

export async function clearLoginFailures(key: string): Promise<void> {
  await getAuthDb().$client.query("DELETE FROM rate_limits WHERE key = $1", [key]);
}

export interface SecurityEvent {
  event: string;
  userId?: string;
  emailHash?: string;
  ip: string | null;
  userAgent: string | null;
  details: Record<string, unknown> | null;
}

export async function addSecurityEvent(e: SecurityEvent): Promise<void> {
  await getAuthDb().$client.query(
    `INSERT INTO security_events (event, user_id, email_hash, ip, user_agent, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.event, e.userId ?? null, e.emailHash ?? null, e.ip, e.userAgent?.slice(0, 500) ?? null, e.details],
  );
}
