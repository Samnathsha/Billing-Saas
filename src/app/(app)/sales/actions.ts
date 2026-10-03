"use server";

import { revalidatePath } from "next/cache";
import { voidInvoice } from "@/modules/sales";
import { errorMessage, formString, LOGGED_OUT, memberCtx, type ActionState } from "@/app/(app)/_shared/action-result";

// Voiding a bill. The service checks permission, the day and everything else.
export async function voidInvoiceAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  if (form.get("confirm") !== "on") return { error: "Tick the box to confirm.", done: null };
  try {
    await voidInvoice(ctx, { idempotencyKey: formString(form, "idempotencyKey"), invoiceId: formString(form, "invoiceId"), reason: formString(form, "reason") });
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/sales", "layout");
  revalidatePath("/inventory");
  return { error: null, done: "Bill voided." };
}
