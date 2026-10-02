"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import type { StaffFormState } from "@/components/forms/staff-forms";
import {
  changeMemberRole,
  deactivateMember,
  getRequestContext,
  InvitationError,
  inviteStaff,
  MemberError,
  PermissionDeniedError,
  revokeInvitation,
} from "@/modules/auth";
import { PlanLimitError } from "@/modules/plans";

// Staff changes. Who acts, and in which business, comes from the session;
// the forms carry only ids, email and role, which the services check.

type MemberCtx = Extract<Awaited<ReturnType<typeof getRequestContext>>, { kind: "member" }>["ctx"];

async function run(work: (ctx: MemberCtx) => Promise<unknown>, done: string): Promise<StaffFormState> {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") return { error: "Please log in again.", info: null };
  try {
    await work(who.ctx);
  } catch (error) {
    if (
      error instanceof MemberError ||
      error instanceof InvitationError ||
      error instanceof PlanLimitError ||
      error instanceof PermissionDeniedError
    ) {
      return { error: error.message, info: null };
    }
    if (error instanceof ZodError) return { error: error.issues[0]?.message ?? "Please check the form.", info: null };
    console.error("staff action failed", error instanceof Error ? error.name : "unknown");
    return { error: "Something went wrong. Please try again.", info: null };
  }
  revalidatePath("/settings/staff");
  return { error: null, info: done };
}

const field = (form: FormData, name: string): unknown => form.get(name);

export async function inviteAction(_previous: StaffFormState, form: FormData): Promise<StaffFormState> {
  return run(
    (ctx) => inviteStaff(ctx, { email: field(form, "email"), roleId: field(form, "roleId") }),
    "Invitation sent. The link works for 7 days.",
  );
}

export async function changeRoleAction(_previous: StaffFormState, form: FormData): Promise<StaffFormState> {
  return run(
    (ctx) => changeMemberRole(ctx, { userId: field(form, "userId"), roleId: field(form, "roleId") }),
    "Role changed. They have been logged out and will log in again with the new role.",
  );
}

export async function deactivateAction(_previous: StaffFormState, form: FormData): Promise<StaffFormState> {
  return run((ctx) => deactivateMember(ctx, { userId: field(form, "userId") }), "Deactivated and logged out everywhere.");
}

export async function revokeAction(_previous: StaffFormState, form: FormData): Promise<StaffFormState> {
  return run((ctx) => revokeInvitation(ctx, { invitationId: field(form, "invitationId") }), "Invitation withdrawn.");
}
