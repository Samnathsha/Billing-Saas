"use server";

import { headers } from "next/headers";
import { ZodError } from "zod";
import type { ProfileFormState } from "@/components/forms/business-profile-form";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { SettingsError, updateBusinessProfile } from "@/modules/tenants";

// Saves the business profile. Who is saving, and for which business, comes
// from the server session; the form only carries the values.
export async function saveBusinessProfile(_previous: ProfileFormState, form: FormData): Promise<ProfileFormState> {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") return { status: "error", message: "Please log in again.", fieldErrors: {} };

  const text = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  try {
    const result = await updateBusinessProfile(who.ctx, {
      businessName: text("businessName"),
      addressLine1: text("addressLine1"),
      addressLine2: text("addressLine2"),
      city: text("city"),
      stateCode: text("stateCode"),
      pincode: text("pincode"),
      phone: text("phone"),
      contactEmail: text("contactEmail"),
      gstRegistration: text("gstRegistration") === "" ? null : text("gstRegistration"),
      gstin: text("gstin"),
      pricesIncludeTax: form.get("pricesIncludeTax") === "on",
      invoicePrefix: text("invoicePrefix"),
      creditNotePrefix: text("creditNotePrefix"),
      version: Number(text("version")),
    });
    return {
      status: "saved",
      message: result.changed ? "Saved." : "Nothing to save: no changes.",
      fieldErrors: {},
      version: result.version,
    };
  } catch (error) {
    if (error instanceof ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of error.issues) {
        const field = String(issue.path[0] ?? "");
        if (field !== "" && fieldErrors[field] === undefined) fieldErrors[field] = issue.message;
      }
      return { status: "error", message: "Please correct the marked fields.", fieldErrors };
    }
    if (error instanceof SettingsError || error instanceof PermissionDeniedError) {
      return { status: "error", message: error.message, fieldErrors: {} };
    }
    console.error("saveBusinessProfile failed", error instanceof Error ? error.name : "unknown");
    return { status: "error", message: "Something went wrong. Please try again.", fieldErrors: {} };
  }
}
