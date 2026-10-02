"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { AcceptState } from "@/components/forms/accept-invite-form";
import { acceptInvitation, AcceptInvitationError } from "@/modules/auth";
import { PlanLimitError } from "@/modules/plans";

// The business comes from the invitation row the database shows this user
// (acceptInvitation), never from the form.
export async function acceptInviteAction(_previous: AcceptState, form: FormData): Promise<AcceptState> {
  try {
    await acceptInvitation(await headers(), { token: form.get("token") });
  } catch (error) {
    if (error instanceof AcceptInvitationError) return { error: error.message };
    if (error instanceof PlanLimitError) {
      return { error: "This business has reached its staff limit. Ask the owner to make room." };
    }
    console.error("acceptInvite failed", error instanceof Error ? error.name : "unknown");
    return { error: "Something went wrong. Please try again." };
  }
  redirect("/dashboard");
}
