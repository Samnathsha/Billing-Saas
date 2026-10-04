"use server";

import { revalidatePath } from "next/cache";
import { createExchange } from "@/modules/sales";
import { errorMessage, memberCtx } from "@/app/(app)/_shared/action-result";

// An exchange: the service checks the return, the new sale and the money,
// all in one transaction.
export async function exchangeAction(input: unknown): Promise<{ ok: true; value: { invoiceId: string; creditNoteId: string } } | { ok: false; error: string }> {
  const ctx = await memberCtx();
  if (ctx === null) return { ok: false, error: "Please log in again." };
  try {
    const value = await createExchange(ctx, input);
    revalidatePath("/sales", "layout");
    revalidatePath("/inventory");
    revalidatePath("/customers", "layout");
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
