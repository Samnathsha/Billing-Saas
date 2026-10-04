"use server";

import { revalidatePath } from "next/cache";
import { registerTill, resolveSyncFlag, revokeTill, setOfflineWindowHours, type RegisteredTillDto } from "@/modules/sync";
import { errorMessage, formString, LOGGED_OUT, memberCtx, type ActionState } from "@/app/(app)/_shared/action-result";

// Tills and offline flags (decision 0006). Who and which business come
// from the session; the services check "Manage tills" (and "Business and
// tax settings" for the offline window).

// Called by the register form ON the computer that becomes the till: the
// answer carries the till's token once, which that browser keeps.
export async function registerTillAction(input: { name: string; branchId: string; prefix: string }): Promise<{ ok: true; till: RegisteredTillDto } | { ok: false; error: string }> {
  const ctx = await memberCtx();
  if (ctx === null) return { ok: false, error: "Please log in again." };
  try {
    const till = await registerTill(ctx, input);
    revalidatePath("/settings/tills");
    return { ok: true, till };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function run(work: (ctx: NonNullable<Awaited<ReturnType<typeof memberCtx>>>) => Promise<unknown>, done: string, path: string): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  try {
    await work(ctx);
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath(path);
  return { error: null, done };
}

export async function revokeTillAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return run((ctx) => revokeTill(ctx, { tillId: formString(form, "tillId") }), "Till revoked. It will be refused at its next sync.", "/settings/tills");
}

export async function offlineWindowAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return run((ctx) => setOfflineWindowHours(ctx, { hours: formString(form, "hours") }), "Saved.", "/settings/tills");
}

export async function resolveFlagAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return run((ctx) => resolveSyncFlag(ctx, { flagId: formString(form, "flagId"), note: formString(form, "note") }), "Marked as reviewed.", "/settings/tills/flags");
}
