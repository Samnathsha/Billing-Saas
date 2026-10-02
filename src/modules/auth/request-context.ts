import "server-only";
import { createTenantContext, withTenant, withUserTransaction, type TenantContext } from "@/db/with-tenant";
import { auth } from "./better-auth";
import * as repo from "./repo";

// Turns a request's session cookie into who is acting and in which business
// (ADR 0003, point 5). The ONLY place a TenantContext is made for a request,
// and only after the membership is confirmed in the database. Called on
// every request; nothing is cached, so a disabled user or membership is
// locked out at once.

export type RequestContext =
  | { kind: "anonymous" }
  // Logged in, but no usable business (none yet, or access was removed).
  | { kind: "no-business"; userId: string }
  | {
      kind: "member";
      userId: string;
      ctx: TenantContext;
      roleName: string;
      permissions: readonly string[];
    };

export async function getRequestContext(headers: Headers): Promise<RequestContext> {
  const session = await auth.api.getSession({ headers });
  if (session === null) return { kind: "anonymous" };
  const { user } = session;
  if (!user.emailVerified || user.status !== "active") return { kind: "anonymous" };

  const token = session.session.token;
  const requested = session.session.activeTenantId ?? null;

  const membership = await withUserTransaction(user.id, async (tx) => {
    if (requested !== null) {
      const found = await repo.findActiveMembership(tx, user.id, requested);
      if (found !== undefined) return { tenantId: requested, roleId: found.roleId };
    }
    // No business chosen, or the chosen one is no longer allowed: in V1 a
    // user has one business, so pick it if there is exactly one.
    const ids = await repo.listActiveBusinessIds(tx, user.id);
    const only = ids.length === 1 ? ids[0] : undefined;
    if (only === undefined) return undefined;
    const found = await repo.findActiveMembership(tx, user.id, only);
    return found === undefined ? undefined : { tenantId: only, roleId: found.roleId };
  });

  if (membership === undefined) {
    if (requested !== null) await repo.setSessionActiveTenant(token, null);
    return { kind: "no-business", userId: user.id };
  }
  if (membership.tenantId !== requested) await repo.setSessionActiveTenant(token, membership.tenantId);

  const ctx = createTenantContext({ tenantId: membership.tenantId, userId: user.id });
  const role = await withTenant(ctx, (tx) => repo.loadRole(tx, membership.roleId));
  if (role === undefined) return { kind: "no-business", userId: user.id };
  return { kind: "member", userId: user.id, ctx, roleName: role.name, permissions: role.permissions };
}
