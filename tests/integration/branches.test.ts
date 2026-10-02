import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auditLogs, memberships, roles } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import {
  BranchError,
  closeBranch,
  createBranch,
  listBranches,
  renameBranch,
  reopenBranch,
} from "@/modules/tenants";
import { PlanLimitError } from "@/modules/plans";
import { registerVerifiedUser } from "../helpers/auth";

// Branches: add, rename, close, reopen; plan limit (pilot: 2), the last open
// branch, names, audit, permissions and other businesses.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function memberCtx(headers: Headers): Promise<TenantContext> {
  const result = await getRequestContext(headers);
  if (result.kind !== "member") throw new Error(`expected a member, got ${result.kind}`);
  return result.ctx;
}

async function newShop(label: string): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template: "clothing" });
  return memberCtx(owner.headers);
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof BranchError || error instanceof PermissionDeniedError || error instanceof PlanLimitError) return error.code;
    if (error instanceof ZodError) return "INVALID_INPUT";
    throw error;
  }
}

const mainBranchId = async (ctx: TenantContext): Promise<string> => (await listBranches(ctx))[0]?.id ?? "";

async function auditActions(ctx: TenantContext): Promise<string[]> {
  // In time order: without ORDER BY the database may return rows in any order.
  const rows = await withTenant(ctx, (tx) =>
    tx.select({ action: auditLogs.action }).from(auditLogs).orderBy(asc(auditLogs.occurredAt), asc(auditLogs.id)),
  );
  return rows.map((r) => r.action).filter((a) => a.startsWith("branch."));
}

describe("adding branches", () => {
  it("a new business has its main branch; a second can be added, a third is over the plan", async () => {
    const ctx = await newShop("Add Branch");
    expect((await listBranches(ctx)).map(({ name, open }) => ({ name, open }))).toEqual([{ name: "Main branch", open: true }]);
    expect(await createBranch(ctx, { name: "  Anna Nagar  " })).toMatchObject({ name: "Anna Nagar", open: true });
    expect(await codeOf(createBranch(ctx, { name: "T Nagar" }))).toBe("LIMIT_REACHED");
    expect((await listBranches(ctx)).map((b) => b.name)).toEqual(["Main branch", "Anna Nagar"]);
    expect(await auditActions(ctx)).toEqual(["branch.created"]);
  });

  it.each([
    ["the same name", "Main branch"],
    ["the same name in other capitals", "MAIN BRANCH"],
  ])("refuses %s", async (_name, name) => {
    const ctx = await newShop("Dup Branch");
    expect(await codeOf(createBranch(ctx, { name }))).toBe("NAME_TAKEN");
  });

  it.each([
    ["an empty name", { name: "   " }],
    ["a name over 100 characters", { name: "x".repeat(101) }],
    ["an extra field", { name: "Ok", tenantId: "00000000-0000-4000-8000-000000000000" }],
  ])("refuses %s", async (_name, input) => {
    const ctx = await newShop("Bad Branch");
    expect(await codeOf(createBranch(ctx, input))).toBe("INVALID_INPUT");
  });
});

describe("renaming", () => {
  it("renames and audits; the same name changes nothing; another branch's name is refused", async () => {
    const ctx = await newShop("Rename");
    const main = await mainBranchId(ctx);
    const second = await createBranch(ctx, { name: "Second" });
    expect(await renameBranch(ctx, { branchId: main, name: "Head office" })).toMatchObject({ name: "Head office" });
    expect(await renameBranch(ctx, { branchId: main, name: "Head office" })).toMatchObject({ name: "Head office" });
    expect(await codeOf(renameBranch(ctx, { branchId: second.id, name: "head OFFICE" }))).toBe("NAME_TAKEN");
    expect(await auditActions(ctx)).toEqual(["branch.created", "branch.renamed"]);
  });
});

describe("closing and reopening", () => {
  it("closes a branch (kept, not deleted), frees a place, and can reopen it if there is room", async () => {
    const ctx = await newShop("Close");
    const second = await createBranch(ctx, { name: "Second" });
    expect(await closeBranch(ctx, { branchId: second.id })).toMatchObject({ open: false });
    expect(await listBranches(ctx)).toHaveLength(2);
    expect(await codeOf(closeBranch(ctx, { branchId: second.id }))).toBe("ALREADY_CLOSED");

    // The freed place is used by a new branch; now reopening would exceed the plan.
    await createBranch(ctx, { name: "Third" });
    expect(await codeOf(reopenBranch(ctx, { branchId: second.id }))).toBe("LIMIT_REACHED");
    // A closed branch's name stays reserved.
    expect(await codeOf(createBranch(ctx, { name: "second" }))).toBe("NAME_TAKEN");
  });

  it("the last open branch cannot be closed", async () => {
    const ctx = await newShop("Last Open");
    expect(await codeOf(closeBranch(ctx, { branchId: await mainBranchId(ctx) }))).toBe("LAST_OPEN_BRANCH");
  });

  it("reopening an open branch is refused; reopening a closed one is audited", async () => {
    const ctx = await newShop("Reopen");
    const second = await createBranch(ctx, { name: "Second" });
    expect(await codeOf(reopenBranch(ctx, { branchId: second.id }))).toBe("ALREADY_OPEN");
    await closeBranch(ctx, { branchId: second.id });
    expect(await reopenBranch(ctx, { branchId: second.id })).toMatchObject({ open: true });
    expect(await auditActions(ctx)).toEqual(["branch.created", "branch.closed", "branch.reopened"]);
  });

  it("closing both open branches at the same moment leaves one open", async () => {
    for (let round = 0; round < 3; round++) {
      const ctx = await newShop(`Close Race ${String(round)}`);
      const main = await mainBranchId(ctx);
      const second = await createBranch(ctx, { name: "Second" });
      const results = await Promise.all([
        codeOf(closeBranch(ctx, { branchId: main })),
        codeOf(closeBranch(ctx, { branchId: second.id })),
      ]);
      expect(results.sort()).toEqual(["LAST_OPEN_BRANCH", "ok"]);
      expect((await listBranches(ctx)).filter((b) => b.open)).toHaveLength(1);
    }
  });
});

describe("who may manage branches", () => {
  it.each(["Manager", "Cashier", "Accountant"])("%s may not", async (role) => {
    const ownerCtx = await newShop(`Branch ${role}`);
    const user = await registerVerifiedUser(`Branch ${role}`);
    await withTenant(ownerCtx, async (tx) => {
      const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
      await tx.insert(memberships).values({ tenantId: ownerCtx.tenantId, userId: user.userId, roleId: r?.id ?? "" });
    });
    const ctx = await memberCtx(user.headers);
    const main = await mainBranchId(ownerCtx);
    expect(await codeOf(listBranches(ctx))).toBe("FORBIDDEN");
    expect(await codeOf(createBranch(ctx, { name: "Sneaky" }))).toBe("FORBIDDEN");
    expect(await codeOf(renameBranch(ctx, { branchId: main, name: "Sneaky" }))).toBe("FORBIDDEN");
    expect(await codeOf(closeBranch(ctx, { branchId: main }))).toBe("FORBIDDEN");
    expect((await listBranches(ownerCtx)).map((b) => b.name)).toEqual(["Main branch"]);
  });
});

describe("another business", () => {
  it("cannot rename, close or reopen another business's branch", async () => {
    const a = await newShop("Branch A");
    const b = await newShop("Branch B");
    const bMain = await mainBranchId(b);
    expect(await codeOf(renameBranch(a, { branchId: bMain, name: "Hacked" }))).toBe("NOT_FOUND");
    expect(await codeOf(closeBranch(a, { branchId: bMain }))).toBe("NOT_FOUND");
    expect(await codeOf(reopenBranch(a, { branchId: bMain }))).toBe("NOT_FOUND");
    expect(await listBranches(b)).toEqual([{ id: bMain, name: "Main branch", open: true }]);
  });
});
