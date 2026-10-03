"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createReturn } from "@/modules/sales";
import { errorMessage, formString, LOGGED_OUT, memberCtx, type ActionState } from "@/app/(app)/_shared/action-result";

// A return. The form names each bill line it returns (qty-<line id>); the
// service checks the lines belong to the bill and every quantity.
export async function returnAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  const lines: { invoiceItemId: string; quantity: string; resellable: boolean }[] = [];
  for (const [key, value] of form.entries()) {
    const match = /^qty-([0-9a-f-]{36})$/.exec(key);
    if (match?.[1] === undefined || typeof value !== "string" || value.trim() === "" || value.trim() === "0") continue;
    lines.push({ invoiceItemId: match[1], quantity: value.trim(), resellable: form.get(`resellable-${match[1]}`) === "on" });
  }
  if (lines.length === 0) return { error: "Enter what comes back on at least one line.", done: null };
  let creditNoteId: string;
  try {
    ({ creditNoteId } = await createReturn(ctx, {
      idempotencyKey: formString(form, "idempotencyKey"),
      creditNoteId: formString(form, "creditNoteId"),
      invoiceId: formString(form, "invoiceId"),
      branchId: formString(form, "branchId"),
      refundMethod: formString(form, "refundMethod"),
      reason: formString(form, "reason"),
      lines,
    }));
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/sales", "layout");
  revalidatePath("/inventory");
  revalidatePath("/customers", "layout");
  redirect(`/credit-notes/${creditNoteId}?saved=1`);
}
