import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { requirePermission, type Permission } from "@/modules/auth";
import { claimIdempotencyKey } from "@/modules/sync";
import * as repo from "./repo";

// Shop expenses (business rules 16): recorded with "Record expenses"
// (Owner, Admin, Manager); viewed also with "View reports" (Accountant).
// Each expense is a money write: one transaction, an idempotency key, an
// audit entry. Never edited: voided with a reason, then entered again.

const VIEW: readonly Permission[] = ["expenses.manage", "reports.view"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Offered with one click; the business can add its own.
export const USUAL_CATEGORIES = ["Rent", "Salaries", "Electricity", "Tea and snacks", "Transport", "Repairs", "Shop supplies", "Other"] as const;

export type ExpenseErrorCode = "NAME_TAKEN" | "NOT_FOUND" | "CATEGORY_ARCHIVED" | "DATE_IN_FUTURE" | "ALREADY_VOIDED";

const MESSAGES: Record<ExpenseErrorCode, string> = {
  NAME_TAKEN: "A category with this name already exists.",
  NOT_FOUND: "Not found.",
  CATEGORY_ARCHIVED: "This category is archived. Choose another or restore it.",
  DATE_IN_FUTURE: "The date cannot be in the future.",
  ALREADY_VOIDED: "This expense is already voided.",
};

export class ExpenseError extends Error {
  constructor(public readonly code: ExpenseErrorCode) {
    super(MESSAGES[code]);
    this.name = "ExpenseError";
  }
}

const day = z
  .string()
  .regex(DATE, { error: "Enter a date." })
  .refine((v) => v >= "2017-07-01" && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), { error: "Enter a valid date." });

export const recordExpenseInput = z.strictObject({
  idempotencyKey: z.uuid(),
  branchId: z.uuid({ error: "Choose a branch." }),
  categoryId: z.uuid({ error: "Choose a category." }),
  amountPaise: z.int({ error: "Enter the amount in paise." }).min(1, { error: "Enter an amount above zero." }).max(100_000_000_000),
  method: z.enum(["cash", "upi", "card", "bank"], { error: "Choose how it was paid." }),
  paidOn: day,
  description: z.string().trim().min(1, { error: "Say what it was for." }).max(200),
  reference: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(60).nullable()).default(null),
});

export interface ExpenseCategoryDto {
  id: string;
  name: string;
  active: boolean;
}

export interface ExpenseDto {
  id: string;
  paidOn: string;
  categoryId: string;
  categoryName: string;
  amountPaise: number;
  method: string;
  description: string;
  reference: string | null;
  status: "posted" | "voided";
  voidReason: string | null;
}

const todayIn = (timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export async function listExpenseCategories(ctx: TenantContext): Promise<ExpenseCategoryDto[]> {
  await requirePermission(ctx, VIEW);
  const rows = await withTenant(ctx, (tx) => repo.listCategories(tx));
  return rows.map((r) => ({ id: r.id, name: r.name, active: r.archivedAt === null }));
}

export async function createExpenseCategory(ctx: TenantContext, rawInput: unknown): Promise<{ id: string }> {
  await requirePermission(ctx, "expenses.manage");
  const { name } = z.strictObject({ name: z.string().trim().min(1, { error: "Enter a name." }).max(60) }).parse(rawInput);
  return withTenant(ctx, async (tx) => {
    if (await repo.categoryNameTaken(tx, name)) throw new ExpenseError("NAME_TAKEN");
    const id = await repo.insertCategory(tx, ctx, name);
    await repo.addAuditEntry(tx, ctx, { action: "expenses.category_created", entityType: "expense_category", entityId: id, before: null, after: { name } });
    return { id };
  });
}

// Adds the usual categories this business does not have yet.
export async function addUsualExpenseCategories(ctx: TenantContext): Promise<{ added: number }> {
  await requirePermission(ctx, "expenses.manage");
  return withTenant(ctx, async (tx) => {
    let added = 0;
    for (const name of USUAL_CATEGORIES) {
      if (await repo.categoryNameTaken(tx, name)) continue;
      const id = await repo.insertCategory(tx, ctx, name);
      await repo.addAuditEntry(tx, ctx, { action: "expenses.category_created", entityType: "expense_category", entityId: id, before: null, after: { name } });
      added += 1;
    }
    return { added };
  });
}

export async function setExpenseCategoryArchived(ctx: TenantContext, rawInput: unknown): Promise<void> {
  await requirePermission(ctx, "expenses.manage");
  const input = z.strictObject({ id: z.uuid(), archived: z.boolean() }).parse(rawInput);
  await withTenant(ctx, async (tx) => {
    const row = await repo.lockCategory(tx, input.id);
    if (row === undefined) throw new ExpenseError("NOT_FOUND");
    if ((row.archivedAt !== null) === input.archived) return;
    await repo.setCategoryArchived(tx, row, input.archived);
    await repo.addAuditEntry(tx, ctx, {
      action: input.archived ? "expenses.category_archived" : "expenses.category_restored",
      entityType: "expense_category",
      entityId: row.id,
      before: { active: row.archivedAt === null },
      after: { active: !input.archived },
    });
  });
}

export async function recordExpense(ctx: TenantContext, rawInput: unknown): Promise<{ expenseId: string }> {
  await requirePermission(ctx, "expenses.manage");
  const input = recordExpenseInput.parse(rawInput);
  const expenseId = randomUUID();
  return withTenant(ctx, async (tx) => {
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "expenses.record", { expenseId });
    if (!claim.claimed) return claim.result;
    if (input.paidOn > todayIn(await repo.timeZone(tx))) throw new ExpenseError("DATE_IN_FUTURE");
    const category = await repo.lockCategory(tx, input.categoryId);
    if (category === undefined) throw new ExpenseError("NOT_FOUND");
    if (category.archivedAt !== null) throw new ExpenseError("CATEGORY_ARCHIVED");
    await repo.insertExpense(tx, ctx, {
      id: expenseId,
      branchId: input.branchId,
      categoryId: category.id,
      amountPaise: input.amountPaise,
      method: input.method,
      paidOn: input.paidOn,
      description: input.description,
      reference: input.reference,
    });
    await repo.addAuditEntry(tx, ctx, {
      action: "expenses.recorded",
      entityType: "expense",
      entityId: expenseId,
      before: null,
      after: { amountPaise: input.amountPaise, method: input.method, paidOn: input.paidOn, description: input.description, category: category.name },
    });
    return { expenseId };
  });
}

export async function voidExpense(ctx: TenantContext, rawInput: unknown): Promise<{ expenseId: string }> {
  await requirePermission(ctx, "expenses.manage");
  const input = z.strictObject({ idempotencyKey: z.uuid(), expenseId: z.uuid(), reason: z.string().trim().min(3, { error: "Say why it is voided." }).max(500) }).parse(rawInput);
  return withTenant(ctx, async (tx) => {
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "expenses.void", { expenseId: input.expenseId });
    if (!claim.claimed) return claim.result;
    const row = await repo.lockExpense(tx, input.expenseId);
    if (row === undefined) throw new ExpenseError("NOT_FOUND");
    if (row.status !== "posted") throw new ExpenseError("ALREADY_VOIDED");
    await repo.markVoided(tx, ctx, row.id, input.reason);
    await repo.addAuditEntry(tx, ctx, { action: "expenses.voided", entityType: "expense", entityId: row.id, before: { status: "posted", amountPaise: row.amountPaise }, after: { status: "voided", reason: input.reason } });
    return { expenseId: row.id };
  });
}

export async function listExpenses(ctx: TenantContext, rawInput: unknown): Promise<ExpenseDto[]> {
  await requirePermission(ctx, VIEW);
  const { from, to } = z.strictObject({ from: day, to: day }).refine((v) => v.from <= v.to, { error: "The start date is after the end date." }).parse(rawInput);
  const rows = await withTenant(ctx, (tx) => repo.listExpenses(tx, from, to));
  return rows.map((r) => ({
    id: r.id,
    paidOn: r.paidOn,
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    amountPaise: r.amountPaise,
    method: r.method,
    description: r.description,
    reference: r.reference,
    status: r.status === "voided" ? "voided" : "posted",
    voidReason: r.voidReason,
  }));
}
