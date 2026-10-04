import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auditLogs, expenses, memberships, roles } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import {
  addUsualExpenseCategories,
  createExpenseCategory,
  ExpenseError,
  listExpenseCategories,
  listExpenses,
  recordExpense,
  setExpenseCategoryArchived,
  USUAL_CATEGORIES,
  voidExpense,
} from "@/modules/expenses";
import { listBranches } from "@/modules/tenants";
import { registerVerifiedUser } from "../helpers/auth";

// Expenses (business rules 16): categories, record once per click, never
// edited (void only), who may, other businesses.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function newShop(label: string): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template: "clothing" });
  const r = await getRequestContext(owner.headers);
  if (r.kind !== "member") throw new Error("expected a member");
  return r.ctx;
}

async function memberWithRole(owner: TenantContext, role: string): Promise<TenantContext> {
  const user = await registerVerifiedUser(`Expense ${role}`);
  await withTenant(owner, async (tx) => {
    const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
    await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
  });
  const result = await getRequestContext(user.headers);
  if (result.kind !== "member") throw new Error("member");
  return result.ctx;
}

async function setup(ctx: TenantContext) {
  await addUsualExpenseCategories(ctx);
  const categoryId = (await listExpenseCategories(ctx)).find((c) => c.name === "Rent")?.id ?? "";
  const branchId = (await listBranches(ctx))[0]?.id ?? "";
  return { categoryId, branchId };
}

const spend = (s: { categoryId: string; branchId: string }, extra: Record<string, unknown> = {}) => ({
  idempotencyKey: randomUUID(),
  ...s,
  amountPaise: 1_500_000,
  method: "bank",
  paidOn: "2026-10-01",
  description: "October rent",
  reference: "NEFT 77",
  ...extra,
});

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof ExpenseError || error instanceof PermissionDeniedError) return error.code;
    if (error instanceof ZodError) return `INVALID:${error.issues.map((i) => i.path.join(".")).join(",")}`;
    throw error;
  }
}

describe("expense categories", () => {
  it("the usual ones once; own ones; names unique; archive and restore", async () => {
    const ctx = await newShop("Expense cats");
    expect(await addUsualExpenseCategories(ctx)).toEqual({ added: USUAL_CATEGORIES.length });
    expect(await addUsualExpenseCategories(ctx)).toEqual({ added: 0 });
    await createExpenseCategory(ctx, { name: "Diwali decorations" });
    expect(await codeOf(createExpenseCategory(ctx, { name: "rent" }))).toBe("NAME_TAKEN");
    const rent = (await listExpenseCategories(ctx)).find((c) => c.name === "Rent");
    await setExpenseCategoryArchived(ctx, { id: rent?.id, archived: true });
    expect((await listExpenseCategories(ctx)).find((c) => c.name === "Rent")?.active).toBe(false);
    expect((await listExpenseCategories(ctx)).map((c) => c.name)).toContain("Diwali decorations");
  });
});

describe("expenses", () => {
  it("recorded once per click, listed by date, audited; voided once; never edited", async () => {
    const ctx = await newShop("Expense record");
    const s = await setup(ctx);
    const input = spend(s);
    const first = await recordExpense(ctx, input);
    expect(await recordExpense(ctx, input)).toEqual(first);
    await recordExpense(ctx, spend(s, { paidOn: "2026-09-15", amountPaise: 20_000, method: "cash", description: "Tea", reference: "" }));
    const october = await listExpenses(ctx, { from: "2026-10-01", to: "2026-10-31" });
    expect(october).toEqual([expect.objectContaining({ id: first.expenseId, categoryName: "Rent", amountPaise: 1_500_000, status: "posted", reference: "NEFT 77" })]);
    expect(await listExpenses(ctx, { from: "2026-09-01", to: "2026-10-31" })).toHaveLength(2);
    const audit = await withTenant(ctx, (tx) => tx.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, first.expenseId)));
    expect(audit).toEqual([{ action: "expenses.recorded" }]);

    const key = randomUUID();
    await voidExpense(ctx, { idempotencyKey: key, expenseId: first.expenseId, reason: "Entered twice" });
    expect(await voidExpense(ctx, { idempotencyKey: key, expenseId: first.expenseId, reason: "Entered twice" })).toEqual(first);
    expect(await codeOf(voidExpense(ctx, { idempotencyKey: randomUUID(), expenseId: first.expenseId, reason: "Again" }))).toBe("ALREADY_VOIDED");
    expect((await listExpenses(ctx, { from: "2026-10-01", to: "2026-10-31" }))[0]).toMatchObject({ status: "voided", voidReason: "Entered twice" });
    await expect(withTenant(ctx, (tx) => tx.update(expenses).set({ amountPaise: 1 }).where(eq(expenses.id, first.expenseId)))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.execute(sql`DELETE FROM expenses`))).rejects.toThrow();
  });

  it("checks the input", async () => {
    const ctx = await newShop("Expense checks");
    const s = await setup(ctx);
    expect(await codeOf(recordExpense(ctx, spend(s, { amountPaise: 0 })))).toBe("INVALID:amountPaise");
    expect(await codeOf(recordExpense(ctx, spend(s, { amountPaise: 10.5 })))).toBe("INVALID:amountPaise");
    expect(await codeOf(recordExpense(ctx, spend(s, { paidOn: "2099-01-01" })))).toBe("DATE_IN_FUTURE");
    expect(await codeOf(recordExpense(ctx, spend(s, { paidOn: "2026-02-30" })))).toBe("INVALID:paidOn");
    expect(await codeOf(recordExpense(ctx, spend(s, { description: "" })))).toBe("INVALID:description");
    expect(await codeOf(recordExpense(ctx, spend(s, { method: "gold" })))).toBe("INVALID:method");
    expect(await codeOf(recordExpense(ctx, spend(s, { categoryId: randomUUID() })))).toBe("NOT_FOUND");
    await setExpenseCategoryArchived(ctx, { id: s.categoryId, archived: true });
    expect(await codeOf(recordExpense(ctx, spend(s)))).toBe("CATEGORY_ARCHIVED");
    expect(await codeOf(listExpenses(ctx, { from: "2026-10-31", to: "2026-10-01" }))).toBe("INVALID:");
  });
});

describe("who may, and another business", () => {
  it("a manager records; an accountant only looks; a cashier neither", async () => {
    const owner = await newShop("Expense roles");
    const s = await setup(owner);
    const manager = await memberWithRole(owner, "Manager");
    expect(await codeOf(recordExpense(manager, spend(s)))).toBe("ok");
    const accountant = await memberWithRole(owner, "Accountant");
    expect(await codeOf(recordExpense(accountant, spend(s)))).toBe("FORBIDDEN");
    expect(await listExpenses(accountant, { from: "2026-10-01", to: "2026-10-31" })).toHaveLength(1);
    const cashier = await memberWithRole(owner, "Cashier");
    expect(await codeOf(recordExpense(cashier, spend(s)))).toBe("FORBIDDEN");
    expect(await codeOf(listExpenses(cashier, { from: "2026-10-01", to: "2026-10-31" }))).toBe("FORBIDDEN");
  });

  it("another business cannot use this one's categories or see or void its expenses", async () => {
    const a = await newShop("Expense A");
    const b = await newShop("Expense B");
    const sb = await setup(b);
    const { expenseId } = await recordExpense(b, spend(sb));
    const aBranch = (await listBranches(a))[0]?.id ?? "";
    expect(await codeOf(recordExpense(a, spend({ categoryId: sb.categoryId, branchId: aBranch })))).toBe("NOT_FOUND");
    expect(await listExpenses(a, { from: "2026-01-01", to: "2026-12-31" })).toEqual([]);
    expect(await codeOf(voidExpense(a, { idempotencyKey: randomUUID(), expenseId, reason: "Attack" }))).toBe("NOT_FOUND");
    expect((await listExpenses(b, { from: "2026-10-01", to: "2026-10-31" }))[0]?.status).toBe("posted");
  });
});
