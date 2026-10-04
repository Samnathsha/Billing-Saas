"use server";

import { revalidatePath } from "next/cache";
import { addUsualExpenseCategories, createExpenseCategory, recordExpense, voidExpense } from "@/modules/expenses";
import { errorMessage, formRupees, formString, LOGGED_OUT, memberCtx, type ActionState } from "@/app/(app)/_shared/action-result";

// Expense screen actions. The services check permission and every value.

async function run(work: (ctx: NonNullable<Awaited<ReturnType<typeof memberCtx>>>) => Promise<unknown>, done: string): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  try {
    await work(ctx);
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/expenses");
  return { error: null, done };
}

export async function recordExpenseAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const amount = formRupees(form, "amount") ?? -1;
  if (amount <= 0) return { error: "Enter the amount in rupees, e.g. 15000 or 249.50.", done: null };
  return run(
    (ctx) =>
      recordExpense(ctx, {
        idempotencyKey: formString(form, "idempotencyKey"),
        branchId: formString(form, "branchId"),
        categoryId: formString(form, "categoryId"),
        amountPaise: amount,
        method: formString(form, "method"),
        paidOn: formString(form, "paidOn"),
        description: formString(form, "description"),
        reference: formString(form, "reference"),
      }),
    "Expense saved.",
  );
}

export async function voidExpenseAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return run((ctx) => voidExpense(ctx, { idempotencyKey: formString(form, "idempotencyKey"), expenseId: formString(form, "expenseId"), reason: formString(form, "reason") }), "Voided.");
}

export async function addCategoryAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return run((ctx) => createExpenseCategory(ctx, { name: formString(form, "name") }), "Category added.");
}

export async function addUsualCategoriesAction(): Promise<ActionState> {
  return run((ctx) => addUsualExpenseCategories(ctx), "Usual categories added.");
}
