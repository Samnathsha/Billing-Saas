import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { memberships, rolePermissions, roles, tenants } from "@/db/schema";
import { createTenantContext, withTenant, type TenantContext } from "@/db/with-tenant";
import {
  createBusiness,
  DEFAULT_ROLES,
  getRequestContext,
  OWNER_ROLE,
  PermissionDeniedError,
  PERMISSIONS,
  requirePermission,
  type Permission,
} from "@/modules/auth";
import { registerVerifiedUser } from "../helpers/auth";

// requirePermission(ctx, key) against the real database: the blueprint 5.3
// role table, and that changes to roles and memberships work at once.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function outcome(ctx: TenantContext, permission: Permission): Promise<string> {
  try {
    await requirePermission(ctx, permission);
    return "allowed";
  } catch (error) {
    if (error instanceof PermissionDeniedError) return error.code;
    throw error;
  }
}

async function memberCtx(headers: Headers): Promise<TenantContext> {
  const result = await getRequestContext(headers);
  if (result.kind !== "member") throw new Error(`expected a member, got ${result.kind}`);
  return result.ctx;
}

async function roleId(ownerCtx: TenantContext, name: string): Promise<string> {
  const [role] = await withTenant(ownerCtx, (tx) => tx.select({ id: roles.id }).from(roles).where(eq(roles.name, name)));
  if (role === undefined) throw new Error(`no role ${name}`);
  return role.id;
}

// A new business with its owner, plus a member for each other role.
// (Staff invitations come later; here the owner adds members directly.)
async function ownerShop(label: string): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template: "clothing" });
  return memberCtx(owner.headers);
}

async function shopWithStaff(label: string): Promise<{ ownerCtx: TenantContext; ctxByRole: Map<string, TenantContext> }> {
  const ownerCtx = await ownerShop(label);
  const ctxByRole = new Map<string, TenantContext>([[OWNER_ROLE, ownerCtx]]);
  for (const name of Object.keys(DEFAULT_ROLES).filter((n) => n !== OWNER_ROLE)) {
    const staff = await registerVerifiedUser(`${label} ${name}`);
    const id = await roleId(ownerCtx, name);
    await withTenant(ownerCtx, (tx) =>
      tx.insert(memberships).values({ tenantId: ownerCtx.tenantId, userId: staff.userId, roleId: id }),
    );
    ctxByRole.set(name, await memberCtx(staff.headers));
  }
  return { ownerCtx, ctxByRole };
}

describe("the default role table (blueprint 5.3)", () => {
  let ctxByRole: Map<string, TenantContext>;
  beforeAll(async () => {
    ({ ctxByRole } = await shopWithStaff("Matrix"));
  });

  const cases = Object.entries(DEFAULT_ROLES).flatMap(([role, granted]) =>
    PERMISSIONS.map((permission) => [role, permission, granted.includes(permission) ? "allowed" : "FORBIDDEN"] as const),
  );

  it("covers every role and every permission", () => {
    expect(cases).toHaveLength(5 * 12);
  });

  it.each(cases)("%s / %s -> %s", async (role, permission, expected) => {
    const ctx = ctxByRole.get(role);
    if (ctx === undefined) throw new Error(`no member for ${role}`);
    expect(await outcome(ctx, permission)).toBe(expected);
  });

  it("matches the blueprint in plain words", async () => {
    const cashier = ctxByRole.get("Cashier");
    const accountant = ctxByRole.get("Accountant");
    const admin = ctxByRole.get("Admin");
    if (cashier === undefined || accountant === undefined || admin === undefined) throw new Error("missing staff");
    expect(await outcome(cashier, "sales.create")).toBe("allowed");
    expect(await outcome(cashier, "invoices.void")).toBe("FORBIDDEN");
    expect(await outcome(accountant, "sales.create")).toBe("FORBIDDEN");
    expect(await outcome(accountant, "reports.view")).toBe("allowed");
    expect(await outcome(admin, "business.delete")).toBe("FORBIDDEN");
  });
});

describe("a refusal", () => {
  it("is a PermissionDeniedError with a safe message", async () => {
    const { ctxByRole } = await shopWithStaff("Refusal");
    const cashier = ctxByRole.get("Cashier");
    if (cashier === undefined) throw new Error("missing cashier");
    const error: unknown = await requirePermission(cashier, "settings.manage").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect(error).toMatchObject({ code: "FORBIDDEN", permission: "settings.manage" });
    expect((error as Error).message).toBe("You do not have permission to do this.");
    expect((error as Error).message).not.toContain(cashier.tenantId);
  });

  it("an unknown permission code is a programming error, not a refusal or a pass", async () => {
    const ownerCtx = await ownerShop("Typo");
    const error: unknown = await requirePermission(ownerCtx, "sales.creat" as Permission).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermissionDeniedError);
  });
});

describe("changes work at once, even for a context made earlier", () => {
  it("removing a permission from a role", async () => {
    const { ownerCtx, ctxByRole } = await shopWithStaff("Revoke");
    const manager = ctxByRole.get("Manager");
    if (manager === undefined) throw new Error("missing manager");
    expect(await outcome(manager, "stock.adjust")).toBe("allowed");
    const managerRole = await roleId(ownerCtx, "Manager");
    await withTenant(ownerCtx, (tx) =>
      tx
        .delete(rolePermissions)
        .where(and(eq(rolePermissions.roleId, managerRole), eq(rolePermissions.permissionCode, "stock.adjust"))),
    );
    expect(await outcome(manager, "stock.adjust")).toBe("FORBIDDEN");
    expect(await outcome(manager, "sales.create")).toBe("allowed");
  });

  it("moving a member to a smaller role", async () => {
    const { ownerCtx, ctxByRole } = await shopWithStaff("Demote");
    const admin = ctxByRole.get("Admin");
    if (admin === undefined) throw new Error("missing admin");
    expect(await outcome(admin, "users.manage")).toBe("allowed");
    const cashierRole = await roleId(ownerCtx, "Cashier");
    await withTenant(ownerCtx, (tx) =>
      tx.update(memberships).set({ roleId: cashierRole }).where(eq(memberships.userId, admin.userId)),
    );
    expect(await outcome(admin, "users.manage")).toBe("FORBIDDEN");
    expect(await outcome(admin, "sales.create")).toBe("allowed");
  });

  it("disabling a member", async () => {
    const { ownerCtx, ctxByRole } = await shopWithStaff("Disable");
    const cashier = ctxByRole.get("Cashier");
    if (cashier === undefined) throw new Error("missing cashier");
    await withTenant(ownerCtx, (tx) =>
      tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.userId, cashier.userId)),
    );
    expect(await outcome(cashier, "sales.create")).toBe("FORBIDDEN");
  });

  it("a suspended business: even the owner is refused", async () => {
    const ownerCtx = await ownerShop("Suspended");
    await withTenant(ownerCtx, (tx) => tx.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, ownerCtx.tenantId)));
    expect(await outcome(ownerCtx, "sales.create")).toBe("FORBIDDEN");
  });
});

describe("another business", () => {
  it("an owner's user id paired with another business's id gets nothing there", async () => {
    const a = await ownerShop("Shop A");
    const b = await ownerShop("Shop B");
    // As if a forged context slipped past the type system and the lint rule.
    const forged = createTenantContext({ tenantId: b.tenantId, userId: a.userId });
    expect(await outcome(a, "business.delete")).toBe("allowed"); // the owner, at home
    for (const permission of PERMISSIONS) expect(await outcome(forged, permission)).toBe("FORBIDDEN");
  });
});
