"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import type { BranchFormState } from "@/components/forms/branch-forms";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { PlanLimitError } from "@/modules/plans";
import { BranchError, closeBranch, createBranch, renameBranch, reopenBranch } from "@/modules/tenants";

// Branch changes. Who and which business come from the session; the form
// carries only the branch id and name, which the service checks.

type Work = (ctx: Extract<Awaited<ReturnType<typeof getRequestContext>>, { kind: "member" }>["ctx"]) => Promise<unknown>;

async function run(work: Work): Promise<BranchFormState> {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") return { error: "Please log in again." };
  try {
    await work(who.ctx);
  } catch (error) {
    if (error instanceof BranchError || error instanceof PlanLimitError || error instanceof PermissionDeniedError) {
      return { error: error.message };
    }
    if (error instanceof ZodError) return { error: error.issues[0]?.message ?? "Please check the name." };
    console.error("branch action failed", error instanceof Error ? error.name : "unknown");
    return { error: "Something went wrong. Please try again." };
  }
  revalidatePath("/settings/branches");
  return { error: null };
}

const text = (form: FormData, name: string): unknown => form.get(name);

export async function addBranchAction(_previous: BranchFormState, form: FormData): Promise<BranchFormState> {
  return run((ctx) => createBranch(ctx, { name: text(form, "name") }));
}

export async function renameBranchAction(_previous: BranchFormState, form: FormData): Promise<BranchFormState> {
  return run((ctx) => renameBranch(ctx, { branchId: text(form, "branchId"), name: text(form, "name") }));
}

export async function toggleBranchAction(_previous: BranchFormState, form: FormData): Promise<BranchFormState> {
  const input = { branchId: text(form, "branchId") };
  return run((ctx) => (form.get("open") === "yes" ? closeBranch(ctx, input) : reopenBranch(ctx, input)));
}
