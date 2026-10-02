import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auditLogs, branches, memberships, rolePermissions, roles, settings, tenants } from "@/db/schema";
import { withTenant, withUserTransaction } from "@/db/with-tenant";
import { createBusiness, DEFAULT_ROLES, getRequestContext, OnboardingError, PERMISSIONS } from "@/modules/auth";
import { lockUserForBusinessCreation } from "@/modules/auth/repo";
import { authServiceUrl } from "../helpers/business";
import { logIn, registerVerifiedUser, type TestLogin } from "../helpers/auth";

// "Set up your business" and the per-request business check (ADR 0003),
// through Better Auth's real login and the app's real services.

let inspector: pg.Client; // auth_service connection, to look at login rows

beforeAll(async () => {
  inspector = new pg.Client({ connectionString: authServiceUrl() });
  await inspector.connect();
});

afterAll(async () => {
  await inspector.end();
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof OnboardingError) return error.code;
    return error instanceof Error ? error.name : String(error);
  }
}

async function memberCtx(headers: Headers) {
  const result = await getRequestContext(headers);
  if (result.kind !== "member") throw new Error(`expected a member, got ${result.kind}`);
  return result;
}

describe("before a business exists", () => {
  it("a request without a session is anonymous, and cannot create a business", async () => {
    expect(await getRequestContext(new Headers())).toEqual({ kind: "anonymous" });
    expect(await codeOf(createBusiness(new Headers(), { businessName: "X", template: "clothing" }))).toBe("NOT_LOGGED_IN");
  });

  it("a logged-in user without a business has no business context", async () => {
    const user = await registerVerifiedUser("Newcomer");
    expect(await getRequestContext(user.headers)).toEqual({ kind: "no-business", userId: user.userId });
  });
});

describe("set up your business", () => {
  let owner: TestLogin;
  let tenantId: string;

  beforeAll(async () => {
    owner = await registerVerifiedUser("Owner One");
    ({ tenantId } = await createBusiness(owner.headers, { businessName: "  Sharma Textiles  ", template: "clothing" }));
  });

  it("creates the business, settings, first branch, owner and audit entry together", async () => {
    const ctx = (await memberCtx(owner.headers)).ctx;
    const data = await withTenant(ctx, async (tx) => ({
      tenant: await tx.select({ name: tenants.name, template: tenants.template }).from(tenants),
      settings: await tx.select({ limit: settings.cashierDiscountLimitBps, inclusive: settings.pricesIncludeTax }).from(settings),
      branches: await tx.select({ name: branches.name }).from(branches),
      memberships: await tx.select({ userId: memberships.userId, status: memberships.status }).from(memberships),
      audit: await tx.select({ action: auditLogs.action, actor: auditLogs.actorUserId }).from(auditLogs),
    }));
    expect(data).toEqual({
      tenant: [{ name: "Sharma Textiles", template: "clothing" }],
      settings: [{ limit: 500, inclusive: true }],
      branches: [{ name: "Main branch" }],
      memberships: [{ userId: owner.userId, status: "active" }],
      audit: [{ action: "business.created", actor: owner.userId }],
    });
  });

  it("creates the five default roles with exactly the blueprint permissions", async () => {
    const ctx = (await memberCtx(owner.headers)).ctx;
    const rows = await withTenant(ctx, (tx) =>
      tx
        .select({ role: roles.name, code: rolePermissions.permissionCode })
        .from(rolePermissions)
        .innerJoin(roles, eq(roles.id, rolePermissions.roleId)),
    );
    const byRole: Record<string, string[]> = {};
    for (const { role, code } of rows) (byRole[role] ??= []).push(code);
    for (const [role, codes] of Object.entries(DEFAULT_ROLES)) {
      expect(byRole[role]?.sort(), role).toEqual([...codes].sort());
    }
    expect(Object.keys(byRole).sort()).toEqual(Object.keys(DEFAULT_ROLES).sort());
  });

  it("each request gets the owner's verified business context", async () => {
    const result = await memberCtx(owner.headers);
    expect(result.ctx.tenantId).toBe(tenantId);
    expect(result.roleName).toBe("Owner");
    expect(result.permissions).toEqual([...PERMISSIONS].sort());
  });

  it("a second business for the same user is refused (V1: one business per user)", async () => {
    expect(await codeOf(createBusiness(owner.headers, { businessName: "Second", template: "mobile" }))).toBe(
      "ALREADY_HAS_BUSINESS",
    );
  });
});

describe("attacks and edge cases", () => {
  it("a double click creates exactly one business", async () => {
    const user = await registerVerifiedUser("Double Clicker");
    const results = await Promise.all([
      codeOf(createBusiness(user.headers, { businessName: "Click 1", template: "clothing" })),
      codeOf(createBusiness(user.headers, { businessName: "Click 2", template: "clothing" })),
    ]);
    expect(results.sort()).toEqual(["ALREADY_HAS_BUSINESS", "ok"]);
    const ctx = (await memberCtx(user.headers)).ctx;
    const { rows } = await withTenant(ctx, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM memberships`));
    expect(rows[0]).toEqual({ n: 1 });
  });

  // The double click above only collides if both land in the same few
  // milliseconds. This test proves the per-user lock deterministically: while
  // the lock is held elsewhere, business creation must wait.
  it("business creation waits for the per-user lock (no gap between check and create)", async () => {
    const user = await registerVerifiedUser("Lock Prover");
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked = (): void => undefined;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = withUserTransaction(user.userId, async (tx) => {
      await lockUserForBusinessCreation(tx, user.userId);
      locked();
      await held;
    });
    await lockTaken;

    let finished = false;
    const creating = createBusiness(user.headers, { businessName: "Waits", template: "clothing" }).then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(finished).toBe(false);

    release();
    await holder;
    await creating;
    expect(finished).toBe(true);
  });

  it.each([
    ["an extra tenantId field (forged)", { businessName: "X", template: "clothing", tenantId: "00000000-0000-4000-8000-000000000000" }],
    ["an extra role field", { businessName: "X", template: "clothing", role: "Owner" }],
    ["an unknown template", { businessName: "X", template: "grocery" }],
    ["an empty name", { businessName: "   ", template: "clothing" }],
  ])("input with %s is rejected", async (_label, input) => {
    const user = await registerVerifiedUser("Bad Input");
    expect(await codeOf(createBusiness(user.headers, input))).toBe("ZodError");
    expect((await getRequestContext(user.headers)).kind).toBe("no-business");
  });

  it("a session pointed at another business (forged) never gives access to it", async () => {
    const shopA = await registerVerifiedUser("Shop A Owner");
    const { tenantId: a } = await createBusiness(shopA.headers, { businessName: "Shop A", template: "clothing" });
    const shopB = await registerVerifiedUser("Shop B Owner");
    const { tenantId: b } = await createBusiness(shopB.headers, { businessName: "Shop B", template: "mobile" });

    // An attacker who could edit B's session row points it at business A.
    await inspector.query("UPDATE sessions SET active_tenant_id = $1 WHERE user_id = $2", [a, shopB.userId]);
    const result = await memberCtx(shopB.headers);
    expect(result.ctx.tenantId).toBe(b);
    const { rows } = await inspector.query("SELECT DISTINCT active_tenant_id FROM sessions WHERE user_id = $1", [shopB.userId]);
    expect(rows).toEqual([{ active_tenant_id: b }]);
  });

  it("a disabled membership loses access on the very next request", async () => {
    const user = await registerVerifiedUser("Removed Staff");
    await createBusiness(user.headers, { businessName: "Short-lived", template: "clothing" });
    const ctx = (await memberCtx(user.headers)).ctx;
    await withTenant(ctx, (tx) => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.userId, user.userId)));
    expect(await getRequestContext(user.headers)).toEqual({ kind: "no-business", userId: user.userId });
  });

  it("a disabled account is shut out at once and cannot log in again", async () => {
    const user = await registerVerifiedUser("Disabled Person");
    await createBusiness(user.headers, { businessName: "Disabled Co", template: "clothing" });
    await inspector.query("UPDATE users SET status = 'disabled' WHERE id = $1", [user.userId]);
    expect(await getRequestContext(user.headers)).toEqual({ kind: "anonymous" });
    expect(await codeOf(logIn(user.email))).not.toBe("ok");
  });

  it("a cashier gets only the cashier's permissions", async () => {
    const owner = await registerVerifiedUser("Boss");
    await createBusiness(owner.headers, { businessName: "Boss Shop", template: "clothing" });
    const ownerCtx = (await memberCtx(owner.headers)).ctx;
    const cashier = await registerVerifiedUser("Till Person");
    // Staff invitations come later (Phase 3/4); here the owner adds a member directly.
    await withTenant(ownerCtx, async (tx) => {
      const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, "Cashier"));
      await tx.insert(memberships).values({ tenantId: ownerCtx.tenantId, userId: cashier.userId, roleId: role?.id ?? "" });
    });
    const result = await memberCtx(cashier.headers);
    expect(result.ctx.tenantId).toBe(ownerCtx.tenantId);
    expect(result.roleName).toBe("Cashier");
    expect(result.permissions).toEqual(["sales.create"]);
  });
});
