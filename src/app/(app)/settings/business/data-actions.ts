"use server";

import { revalidatePath } from "next/cache";
import { cancelBusinessDeletion, requestBusinessDeletion } from "@/modules/tenants";
import { errorMessage, formString, LOGGED_OUT, memberCtx, type ActionState } from "@/app/(app)/_shared/action-result";

// Asking for (or cancelling) the deletion of the business: Owner only, the
// service checks it. The business comes from the session.
export async function requestDeletionAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  try {
    await requestBusinessDeletion(ctx, { confirmName: formString(form, "confirmName") });
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/", "layout");
  return { error: null, done: "Deletion requested." };
}

export async function cancelDeletionAction(): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  try {
    await cancelBusinessDeletion(ctx);
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/", "layout");
  return { error: null, done: "Deletion cancelled." };
}
