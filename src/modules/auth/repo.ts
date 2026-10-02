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

// Is this user account still allowed to log in? (Read by the login library's
// role, before any business is known.)
export async function isUserActive(userId: string): Promise<boolean> {
  const result = await getAuthDb().$client.query<{ ok: boolean }>(
    "SELECT status = 'active' AS ok FROM users WHERE id = $1",
    [userId],
  );
  return result.rows[0]?.ok === true;
}
