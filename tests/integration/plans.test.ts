import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { branches, devices, memberships, roles, subscriptions } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { getPlanUsage, PlanLimitError, requireCapacity, type PlanResource } from "@/modules/tenants";
import { createTestBusiness, createTestUser } from "../helpers/business";
import { registerVerifiedUser } from "../helpers/auth";

// Plans and limits (owner decision 2026-10-02: pilot = 2 branches, 10 staff,
// 5 tills). requireCapacity is called inside the transaction that adds.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function newShop(label: string): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template: "clothing" });
  const result = await getRequestContext(owner.headers);
  if (result.kind !== "member") throw new Error("expected a member");
  return result.ctx;
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof PlanLimitError) return `${error.code}:${error.resource}:${String(error.limit)}`;
    if (error instanceof PermissionDeniedError) return error.code;
    throw error;
  }
}

// Checks capacity and adds one, in one transaction, as the services will.
// `pauseSeconds` keeps the transaction open between the check and the add,
// like a slow request, so parallel attempts really overlap.
function addBranch(ctx: TenantContext, name = `Branch ${randomUUID().slice(0, 8)}`, pauseSeconds = 0) {
  return withTenant(ctx, async (tx) => {
    await requireCapacity(tx, ctx, "branches");
    if (pauseSeconds > 0) await tx.execute(sql`SELECT pg_sleep(${pauseSeconds})`);
    await tx.insert(branches).values({ tenantId: ctx.tenantId, name });
  });
}

async function addMember(ctx: TenantContext) {
  const userId = randomUUID();
  await createTestUser(userId, "Plan Staff");
  return withTenant(ctx, async (tx) => {
    await requireCapacity(tx, ctx, "users");
    const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, "Cashier"));
    await tx.insert(memberships).values({ tenantId: ctx.tenantId, userId, roleId: role?.id ?? "" });
  });
}

function addDevice(ctx: TenantContext) {
  return withTenant(ctx, async (tx) => {
    await requireCapacity(tx, ctx, "devices");
    const [branch] = await tx.select({ id: branches.id }).from(branches).limit(1);
    await tx.insert(devices).values({ tenantId: ctx.tenantId, branchId: branch?.id ?? "", name: `Till ${randomUUID().slice(0, 6)}` });
  });
}

describe("the pilot plan", () => {
  it("is the default, with the owner's numbers, and the app can read it", async () => {
    const { rows } = await withTenant(await newShop("Read Plans"), (tx) =>
      tx.execute(sql`SELECT code, price_monthly_paise, max_branches, max_users, max_devices FROM plans WHERE is_default`),
    );
    expect(rows).toEqual([{ code: "pilot", price_monthly_paise: "0", max_branches: 2, max_users: 10, max_devices: 5 }]);
  });

  it("a new business is on it, with its main branch and owner already counted", async () => {
    const ctx = await newShop("New Plan");
    expect(await getPlanUsage(ctx)).toEqual({
      planName: "Pilot",
      status: "active",
      usage: [
        { resource: "branches", used: 1, limit: 2 },
        { resource: "users", used: 1, limit: 10 },
        { resource: "devices", used: 0, limit: 5 },
      ],
    });
  });
});

describe("limits", () => {
  it("branches: a second one fits, a third is refused; an archived one frees a place", async () => {
    const ctx = await newShop("Branch Limit");
    expect(await codeOf(addBranch(ctx, "Second"))).toBe("ok");
    expect(await codeOf(addBranch(ctx, "Third"))).toBe("LIMIT_REACHED:branches:2");
    await withTenant(ctx, (tx) => tx.update(branches).set({ archivedAt: new Date() }).where(eq(branches.name, "Second")));
    expect(await codeOf(addBranch(ctx, "Third"))).toBe("ok");
  });

  it("staff: 10 members including the owner, the 11th is refused; a disabled one frees a place", async () => {
    const ctx = await newShop("User Limit");
    for (let i = 0; i < 9; i++) expect(await codeOf(addMember(ctx))).toBe("ok");
    expect(await codeOf(addMember(ctx))).toBe("LIMIT_REACHED:users:10");
    await withTenant(ctx, async (tx) => {
      const [one] = await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.status, "active")).limit(1).offset(1);
      await tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, one?.id ?? ""));
    });
    expect(await codeOf(addMember(ctx))).toBe("ok");
  });

  it("tills: 5, the 6th is refused", async () => {
    const ctx = await newShop("Device Limit");
    for (let i = 0; i < 5; i++) expect(await codeOf(addDevice(ctx))).toBe("ok");
    expect(await codeOf(addDevice(ctx))).toBe("LIMIT_REACHED:devices:5");
  });

  it("two branches added at the same moment: only one fits", async () => {
    const ctx = await newShop("Race");
    const attempt = () => codeOf(addBranch(ctx, undefined, 0.3));
    const results = await Promise.all([attempt(), attempt(), attempt()]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "LIMIT_REACHED:branches:2")).toHaveLength(2);
    const usage = await getPlanUsage(ctx);
    expect(usage?.usage[0]).toEqual({ resource: "branches", used: 2, limit: 2 });
  });

  it("a business without a plan can add nothing (fails closed)", async () => {
    const { ctx } = await createTestBusiness("No Plan Shop");
    for (const resource of ["branches", "users", "devices"] as PlanResource[]) {
      expect(await codeOf(withTenant(ctx, (tx) => requireCapacity(tx, ctx, resource)))).toBe(`NO_ACTIVE_PLAN:${resource}:null`);
    }
  });
});

describe("a shop cannot change its plan", () => {
  it.each([
    ["raise its own limits", sql`UPDATE plans SET max_branches = 100`],
    ["create a plan", sql`INSERT INTO plans (code, name, max_branches, max_users, max_devices) VALUES ('mine', 'Mine', 99, 99, 99)`],
    ["delete the plan", sql`DELETE FROM plans`],
    ["switch its subscription", sql`UPDATE subscriptions SET plan_code = 'pilot', status = 'active'`],
    ["delete its subscription", sql`DELETE FROM subscriptions`],
  ])("%s: refused", async (_name, statement) => {
    const ctx = await newShop("Tamper");
    // The database's own reason is inside Drizzle's "Failed query" error.
    const error: unknown = await withTenant(ctx, (tx) => tx.execute(statement)).catch((e: unknown) => e);
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
    expect(cause).toMatch(/permission denied/);
  });

  it("a second subscription for the same business is refused", async () => {
    const ctx = await newShop("Second Sub");
    await expect(
      withTenant(ctx, (tx) => tx.insert(subscriptions).values({ tenantId: ctx.tenantId, planCode: "pilot" })),
    ).rejects.toThrow();
  });
});

describe("who may see the plan", () => {
  it("only those with business settings rights", async () => {
    const ownerCtx = await newShop("Plan View");
    const cashier = await registerVerifiedUser("Plan Cashier");
    await withTenant(ownerCtx, async (tx) => {
      const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, "Cashier"));
      await tx.insert(memberships).values({ tenantId: ownerCtx.tenantId, userId: cashier.userId, roleId: role?.id ?? "" });
    });
    const result = await getRequestContext(cashier.headers);
    if (result.kind !== "member") throw new Error("expected a member");
    expect(await codeOf(getPlanUsage(result.ctx))).toBe("FORBIDDEN");
  });
});
