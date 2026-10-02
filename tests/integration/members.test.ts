import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auditLogs, memberships, roles } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import {
  changeMemberRole,
  createBusiness,
  deactivateMember,
  getRequestContext,
  MemberError,
  OWNER_ROLE,
  PermissionDeniedError,
} from "@/modules/auth";
import { logIn, registerVerifiedUser, type TestLogin } from "../helpers/auth";

// Changing a member's role and deactivating a member (owner decisions
// 2026-10-02): rules, audit entries, and that every session of the member
// ends at once.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof MemberError) return error.code;
    if (error instanceof PermissionDeniedError) return error.code;
    if (error instanceof ZodError) return "INVALID_INPUT";
    throw error;
  }
}

async function memberCtx(headers: Headers): Promise<TenantContext> {
  const result = await getRequestContext(headers);
  if (result.kind !== "member") throw new Error(`expected a member, got ${result.kind}`);
  return result.ctx;
}

async function roleId(ctx: TenantContext, name: string): Promise<string> {
  const [role] = await withTenant(ctx, (tx) => tx.select({ id: roles.id }).from(roles).where(eq(roles.name, name)));
  if (role === undefined) throw new Error(`no role ${name}`);
  return role.id;
}

interface Shop {
  owner: TestLogin;
  ownerCtx: TenantContext;
  add(role: string, label?: string): Promise<TestLogin & { ctx: TenantContext }>;
}

async function newShop(label: string): Promise<Shop> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template: "clothing" });
  const ownerCtx = await memberCtx(owner.headers);
  return {
    owner,
    ownerCtx,
    async add(role, name = role) {
      const user = await registerVerifiedUser(`${label} ${name}`);
      const id = await roleId(ownerCtx, role);
      await withTenant(ownerCtx, (tx) => tx.insert(memberships).values({ tenantId: ownerCtx.tenantId, userId: user.userId, roleId: id }));
      return { ...user, ctx: await memberCtx(user.headers) };
    },
  };
}

const isLoggedIn = async (headers: Headers): Promise<boolean> => (await getRequestContext(headers)).kind !== "anonymous";

async function auditActions(ctx: TenantContext): Promise<string[]> {
  const rows = await withTenant(ctx, (tx) => tx.select({ action: auditLogs.action }).from(auditLogs));
  return rows.map((r) => r.action);
}

describe("change a member's role", () => {
  it("the owner moves a cashier up to manager: all their logins end, the new login has the new role", async () => {
    const shop = await newShop("Promote");
    const cashier = await shop.add("Cashier");
    const cashierPhone = await logIn(cashier.email);
    const result = await changeMemberRole(shop.ownerCtx, { userId: cashier.userId, roleId: await roleId(shop.ownerCtx, "Manager") });
    expect(result).toEqual({ changed: true });
    expect(await isLoggedIn(cashier.headers)).toBe(false);
    expect(await isLoggedIn(cashierPhone)).toBe(false);
    expect(await isLoggedIn(shop.owner.headers)).toBe(true);

    const again = await getRequestContext(await logIn(cashier.email));
    expect(again.kind === "member" ? again.roleName : again.kind).toBe("Manager");
    expect(await auditActions(shop.ownerCtx)).toContain("member.role_changed");
  });

  it("an admin may manage another admin", async () => {
    const shop = await newShop("Admins");
    const admin = await shop.add("Admin", "First Admin");
    const other = await shop.add("Admin", "Second Admin");
    expect(await codeOf(changeMemberRole(admin.ctx, { userId: other.userId, roleId: await roleId(shop.ownerCtx, "Cashier") }))).toBe("ok");
  });

  it("giving the role someone already has changes nothing and keeps them logged in", async () => {
    const shop = await newShop("Same Role");
    const cashier = await shop.add("Cashier");
    const result = await changeMemberRole(shop.ownerCtx, { userId: cashier.userId, roleId: await roleId(shop.ownerCtx, "Cashier") });
    expect(result).toEqual({ changed: false });
    expect(await isLoggedIn(cashier.headers)).toBe(true);
  });
});

describe("deactivate a member", () => {
  it("an admin deactivates a cashier: all their logins end, and they have no business after logging in", async () => {
    const shop = await newShop("Deactivate");
    const admin = await shop.add("Admin");
    const cashier = await shop.add("Cashier");
    const cashierTablet = await logIn(cashier.email);
    expect(await deactivateMember(admin.ctx, { userId: cashier.userId })).toEqual({ changed: true });
    expect(await isLoggedIn(cashier.headers)).toBe(false);
    expect(await isLoggedIn(cashierTablet)).toBe(false);
    expect((await getRequestContext(await logIn(cashier.email))).kind).toBe("no-business");
    expect(await auditActions(shop.ownerCtx)).toContain("member.deactivated");
    // A second time changes nothing.
    expect(await deactivateMember(admin.ctx, { userId: cashier.userId })).toEqual({ changed: false });
  });
});

describe("the rules", () => {
  it("nobody can change or deactivate the owner", async () => {
    const shop = await newShop("Protect Owner");
    const admin = await shop.add("Admin");
    const cashierRole = await roleId(shop.ownerCtx, "Cashier");
    expect(await codeOf(changeMemberRole(admin.ctx, { userId: shop.owner.userId, roleId: cashierRole }))).toBe("CANNOT_CHANGE_OWNER");
    expect(await codeOf(deactivateMember(admin.ctx, { userId: shop.owner.userId }))).toBe("CANNOT_CHANGE_OWNER");
    expect(await isLoggedIn(shop.owner.headers)).toBe(true);
  });

  it("nobody can change or deactivate themselves", async () => {
    const shop = await newShop("Self");
    const admin = await shop.add("Admin");
    const cashierRole = await roleId(shop.ownerCtx, "Cashier");
    expect(await codeOf(changeMemberRole(admin.ctx, { userId: admin.userId, roleId: cashierRole }))).toBe("CANNOT_CHANGE_SELF");
    expect(await codeOf(deactivateMember(admin.ctx, { userId: admin.userId }))).toBe("CANNOT_CHANGE_SELF");
    expect(await codeOf(deactivateMember(shop.ownerCtx, { userId: shop.owner.userId }))).toBe("CANNOT_CHANGE_SELF");
  });

  it("the owner role cannot be given", async () => {
    const shop = await newShop("No New Owner");
    const admin = await shop.add("Admin");
    const ownerRole = await roleId(shop.ownerCtx, OWNER_ROLE);
    expect(await codeOf(changeMemberRole(shop.ownerCtx, { userId: admin.userId, roleId: ownerRole }))).toBe("CANNOT_ASSIGN_OWNER");
  });

  it("without 'Manage users' (manager, cashier) nothing happens", async () => {
    const shop = await newShop("No Rights");
    const manager = await shop.add("Manager");
    const cashier = await shop.add("Cashier");
    const managerRole = await roleId(shop.ownerCtx, "Manager");
    expect(await codeOf(changeMemberRole(cashier.ctx, { userId: cashier.userId, roleId: managerRole }))).toBe("FORBIDDEN");
    expect(await codeOf(deactivateMember(manager.ctx, { userId: cashier.userId }))).toBe("FORBIDDEN");
    expect(await isLoggedIn(cashier.headers)).toBe(true);
    expect(await auditActions(shop.ownerCtx)).not.toContain("member.deactivated");
  });

  it("another business's members and roles are out of reach", async () => {
    const a = await newShop("Shop A");
    const b = await newShop("Shop B");
    const bCashier = await b.add("Cashier");
    expect(await codeOf(deactivateMember(a.ownerCtx, { userId: bCashier.userId }))).toBe("MEMBER_NOT_FOUND");
    expect(await isLoggedIn(bCashier.headers)).toBe(true);
    const aCashier = await a.add("Cashier");
    const bManagerRole = await roleId(b.ownerCtx, "Manager");
    expect(await codeOf(changeMemberRole(a.ownerCtx, { userId: aCashier.userId, roleId: bManagerRole }))).toBe("ROLE_NOT_FOUND");
  });

  it("input must be exactly the expected ids", async () => {
    const shop = await newShop("Strict");
    const cashier = await shop.add("Cashier");
    expect(await codeOf(deactivateMember(shop.ownerCtx, { userId: "x" }))).toBe("INVALID_INPUT");
    expect(await codeOf(deactivateMember(shop.ownerCtx, { userId: cashier.userId, tenantId: shop.ownerCtx.tenantId }))).toBe("INVALID_INPUT");
    expect(await isLoggedIn(cashier.headers)).toBe(true);
  });
});
