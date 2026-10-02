"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import type { SetupState } from "@/components/forms/setup-form";
import { createBusiness, OnboardingError, type OnboardingErrorCode } from "@/modules/auth";

const MESSAGES: Record<OnboardingErrorCode, string> = {
  NOT_LOGGED_IN: "Please log in again.",
  EMAIL_NOT_VERIFIED: "Please confirm your email address first.",
  ACCOUNT_DISABLED: "This account is disabled.",
  ALREADY_HAS_BUSINESS: "You already have a business.",
};

// "Set up your business". The business id and the owner come from the
// server session inside createBusiness, never from the form.
export async function setUpBusiness(_previous: SetupState, form: FormData): Promise<SetupState> {
  try {
    await createBusiness(await headers(), {
      businessName: form.get("businessName"),
      template: form.get("template"),
    });
  } catch (error) {
    if (error instanceof OnboardingError) {
      if (error.code === "ALREADY_HAS_BUSINESS") redirect("/dashboard");
      if (error.code === "NOT_LOGGED_IN") redirect("/login");
      return { error: MESSAGES[error.code] };
    }
    if (error instanceof ZodError) {
      return { error: "Please enter your business name (up to 200 characters) and choose a shop type." };
    }
    console.error("setUpBusiness failed", error instanceof Error ? error.name : "unknown");
    return { error: "Something went wrong. Please try again." };
  }
  redirect("/dashboard");
}
