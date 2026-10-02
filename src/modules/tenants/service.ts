import "server-only";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { requirePermission } from "@/modules/auth";
import { GST_REGISTRATIONS, GST_STATES, gstinProblem, isGstStateCode, needsGstin, normaliseGstin } from "@/modules/tax";
import * as repo from "./repo";

// Business profile and GST settings (blueprint Phase 4, rules 1.x and 4.5).
// Only "Business and tax settings" (Owner, Admin) may read or change them
// here. Every change is audited with the old and new values.

export type SettingsErrorCode = "CHANGED_BY_SOMEONE_ELSE" | "NOT_FOUND";

export class SettingsError extends Error {
  constructor(public readonly code: SettingsErrorCode) {
    super(
      code === "CHANGED_BY_SOMEONE_ELSE"
        ? "Someone else changed these settings meanwhile. Please reload the page and try again."
        : "Business settings were not found.",
    );
    this.name = "SettingsError";
  }
}

export interface BusinessProfileDto {
  businessName: string;
  template: "clothing" | "mobile";
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  stateCode: string | null;
  stateName: string | null;
  pincode: string | null;
  phone: string | null;
  contactEmail: string | null;
  gstRegistration: "registered" | "composition" | "unregistered" | null;
  gstin: string | null;
  pricesIncludeTax: boolean;
  version: number;
}

// Blank text fields mean "not given".
const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : typeof v === "string" ? v.trim() : v),
    z.string().max(max, { error: `Use at most ${String(max)} characters.` }).nullable(),
  );

export const businessProfileInput = z
  .strictObject({
    businessName: z.string().trim().min(1, { error: "Enter the business name." }).max(200, { error: "Use at most 200 characters." }),
    addressLine1: optionalText(200),
    addressLine2: optionalText(200),
    city: optionalText(100),
    stateCode: optionalText(2).refine((v) => v === null || isGstStateCode(v), { error: "Choose a state from the list." }),
    pincode: optionalText(6).refine((v) => v === null || /^[1-9][0-9]{5}$/.test(v), { error: "A PIN code has 6 digits." }),
    phone: optionalText(20).refine((v) => v === null || /^[+0-9 -]{6,20}$/.test(v), { error: "Use digits, spaces, + or - only." }),
    contactEmail: optionalText(254).refine((v) => v === null || z.email().safeParse(v).success, { error: "Enter a valid email address." }),
    gstRegistration: z.enum(GST_REGISTRATIONS, { error: "Choose how the business is registered for GST." }),
    gstin: z.preprocess((v) => (typeof v === "string" ? normaliseGstin(v) || null : v), z.string().max(15).nullable()),
    pricesIncludeTax: z.boolean(),
    version: z.int().positive(),
  })
  .superRefine((input, issue) => {
    if (!needsGstin(input.gstRegistration)) {
      if (input.gstin !== null) issue.addIssue({ code: "custom", path: ["gstin"], message: "An unregistered business has no GSTIN. Clear this field." });
      return;
    }
    if (input.gstin === null) {
      issue.addIssue({ code: "custom", path: ["gstin"], message: "Enter the GSTIN." });
      return;
    }
    const problem = gstinProblem(input.gstin);
    if (problem !== null) {
      issue.addIssue({ code: "custom", path: ["gstin"], message: "This GSTIN is not valid. Check it for typing mistakes." });
      return;
    }
    if (input.stateCode === null) {
      issue.addIssue({ code: "custom", path: ["stateCode"], message: "Choose the state of the GST registration." });
    } else if (input.gstin.slice(0, 2) !== input.stateCode) {
      issue.addIssue({ code: "custom", path: ["gstin"], message: "The GSTIN belongs to another state than the one chosen." });
    }
  });

function toDto(row: repo.ProfileRow): BusinessProfileDto {
  return {
    businessName: row.businessName,
    template: row.template === "mobile" ? "mobile" : "clothing",
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    stateCode: row.stateCode,
    stateName: row.stateCode === null ? null : (GST_STATES.get(row.stateCode) ?? null),
    pincode: row.pincode,
    phone: row.phone,
    contactEmail: row.contactEmail,
    gstRegistration: GST_REGISTRATIONS.find((r) => r === row.gstRegistration) ?? null,
    gstin: row.gstin,
    pricesIncludeTax: row.pricesIncludeTax,
    version: row.version,
  };
}

export async function getBusinessProfile(ctx: TenantContext): Promise<BusinessProfileDto> {
  await requirePermission(ctx, "settings.manage");
  const row = await withTenant(ctx, (tx) => repo.getProfile(tx, ctx));
  if (row === undefined) throw new SettingsError("NOT_FOUND");
  return toDto(row);
}

const EDITABLE = [
  "businessName",
  "addressLine1",
  "addressLine2",
  "city",
  "stateCode",
  "pincode",
  "phone",
  "contactEmail",
  "gstRegistration",
  "gstin",
  "pricesIncludeTax",
] as const;

export async function updateBusinessProfile(
  ctx: TenantContext,
  rawInput: unknown,
): Promise<{ changed: boolean; version: number }> {
  await requirePermission(ctx, "settings.manage");
  const input = businessProfileInput.parse(rawInput);

  return withTenant(ctx, async (tx) => {
    const current = await repo.lockProfile(tx, ctx);
    if (current === undefined) throw new SettingsError("NOT_FOUND");
    // Saved from a page that showed an older version: refuse rather than
    // silently overwrite someone else's change.
    if (current.version !== input.version) throw new SettingsError("CHANGED_BY_SOMEONE_ELSE");

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of EDITABLE) {
      if (current[key] !== input[key]) {
        before[key] = current[key];
        after[key] = input[key];
      }
    }
    if (Object.keys(after).length === 0) return { changed: false, version: current.version };

    const version = current.version + 1;
    const values: repo.ProfileValues = {
      businessName: input.businessName,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2,
      city: input.city,
      stateCode: input.stateCode,
      pincode: input.pincode,
      phone: input.phone,
      contactEmail: input.contactEmail,
      gstRegistration: input.gstRegistration,
      gstin: input.gstin,
      pricesIncludeTax: input.pricesIncludeTax,
    };
    await repo.saveProfile(tx, ctx, values, version);
    await repo.addAuditEntry(tx, ctx, {
      actorRole: await repo.actorRoleName(tx, ctx),
      action: "settings.profile_updated",
      entityType: "tenant",
      entityId: ctx.tenantId,
      before,
      after,
    });
    return { changed: true, version };
  });
}
