import "server-only";
import { z } from "zod";
import { withTenant, type TenantContext, type TenantTx } from "@/db/with-tenant";
import { requirePermission } from "@/modules/auth";
import { limitOf, readPlanUsage, requireCapacity } from "@/modules/plans";
import { tillCreditNotePrefix } from "@/lib/document-number";
import { financialYearLabel, financialYearStart, PREFIX_PATTERN } from "@/modules/sales";
import { GST_REGISTRATIONS, GST_STATES, gstinProblem, isGstStateCode, needsGstin, normaliseGstin } from "@/modules/tax";
import * as repo from "./repo";

// Business profile and GST settings (blueprint Phase 4, rules 1.x and 4.5).
// Only "Business and tax settings" (Owner, Admin) may read or change them
// here. Every change is audited with the old and new values.

export type SettingsErrorCode = "CHANGED_BY_SOMEONE_ELSE" | "NOT_FOUND" | "LOCKED_BY_PRODUCTS" | "PREFIX_LOCKED" | "PREFIX_USED_BY_TILL";

export class SettingsError extends Error {
  constructor(public readonly code: SettingsErrorCode) {
    super(
      code === "CHANGED_BY_SOMEONE_ELSE"
        ? "Someone else changed these settings meanwhile. Please reload the page and try again."
        : code === "LOCKED_BY_PRODUCTS"
          ? "This cannot be changed once products exist (it would change what every product and price means)."
          : code === "PREFIX_LOCKED"
            ? "Bills (or credit notes) have already been numbered with this prefix this financial year. It can be changed from 1 April."
            : code === "PREFIX_USED_BY_TILL"
              ? "A till uses this prefix (or it is a till's credit-note prefix). Choose another."
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
  invoicePrefix: string;
  creditNotePrefix: string;
  // The current financial year as printed in numbers, e.g. "26-27".
  financialYear: string;
  version: number;
}

// "inv " -> "INV". Prefixes are 1-4 capital letters or digits.
const prefix = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
  z.string().regex(PREFIX_PATTERN, { error: "Use 1 to 4 letters or digits, e.g. INV." }),
);

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
    invoicePrefix: prefix,
    creditNotePrefix: prefix,
    version: z.int().positive(),
  })
  .superRefine((input, issue) => {
    if (input.invoicePrefix === input.creditNotePrefix) {
      issue.addIssue({ code: "custom", path: ["creditNotePrefix"], message: "Use a different prefix from the bills." });
    }
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
    invoicePrefix: row.invoicePrefix,
    creditNotePrefix: row.creditNotePrefix,
    financialYear: financialYearLabel(
      financialYearStart(new Date(), row.timeZone, row.financialYearStartMonth),
      row.financialYearStartMonth,
    ),
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
  "invoicePrefix",
  "creditNotePrefix",
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

    // Open question 28: locked once products exist.
    if (input.pricesIncludeTax !== current.pricesIncludeTax && (await repo.hasProducts(tx))) {
      throw new SettingsError("LOCKED_BY_PRODUCTS");
    }
    // Business rules 12: a prefix is fixed once this year's series started.
    const financialYear = financialYearLabel(financialYearStart(new Date(), current.timeZone, current.financialYearStartMonth), current.financialYearStartMonth);
    const prefixChanges = [
      { kind: "invoice", from: current.invoicePrefix, to: input.invoicePrefix },
      { kind: "credit_note", from: current.creditNotePrefix, to: input.creditNotePrefix },
    ].filter((c) => c.from !== c.to);
    for (const change of prefixChanges) {
      if (await repo.seriesStarted(tx, { kind: change.kind, prefix: change.from, financialYear })) throw new SettingsError("PREFIX_LOCKED");
    }
    // A till's series (decision 0006): its prefix and prefix + R.
    if (prefixChanges.length > 0) {
      const tillSeries = new Set((await repo.tillPrefixes(tx)).flatMap((p) => [p, tillCreditNotePrefix(p)]));
      if (prefixChanges.some((c) => tillSeries.has(c.to))) throw new SettingsError("PREFIX_USED_BY_TILL");
    }
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
      invoicePrefix: input.invoicePrefix,
      creditNotePrefix: input.creditNotePrefix,
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

export interface PlanUsageDto {
  planName: string;
  status: string;
  usage: { resource: "branches" | "users" | "devices"; used: number; limit: number }[];
}

// "Your plan" on the settings page: limits and what is used.
export async function getPlanUsage(ctx: TenantContext): Promise<PlanUsageDto | null> {
  await requirePermission(ctx, "settings.manage");
  return withTenant(ctx, async (tx) => {
    const found = await readPlanUsage(tx, ctx);
    if (found === undefined) return null;
    const { plan, used } = found;
    return {
      planName: plan.name,
      status: plan.status,
      usage: (["branches", "users", "devices"] as const).map((resource) => ({
        resource,
        used: used[resource],
        limit: limitOf(plan, resource),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Branches (shop locations). Owner and Admin ("Business and tax settings").
// A branch is closed (archived), never deleted, so its history stays; it can
// be reopened if the plan has room. The last open branch cannot be closed.
// Every change is audited. Stock in a closed branch: Phase 6 rule.

export type BranchErrorCode = "NOT_FOUND" | "NAME_TAKEN" | "LAST_OPEN_BRANCH" | "ALREADY_CLOSED" | "ALREADY_OPEN";

const MESSAGES: Record<BranchErrorCode, string> = {
  NOT_FOUND: "This branch was not found.",
  NAME_TAKEN: "Another branch already has this name.",
  LAST_OPEN_BRANCH: "This is the only open branch. Open or add another branch first.",
  ALREADY_CLOSED: "This branch is already closed.",
  ALREADY_OPEN: "This branch is already open.",
};

export class BranchError extends Error {
  constructor(public readonly code: BranchErrorCode) {
    super(MESSAGES[code]);
    this.name = "BranchError";
  }
}

export interface BranchDto {
  id: string;
  name: string;
  open: boolean;
}

const branchName = z
  .string()
  .trim()
  .min(1, { error: "Enter a branch name." })
  .max(100, { error: "Use at most 100 characters." });

export const createBranchInput = z.strictObject({ name: branchName });
export const renameBranchInput = z.strictObject({ branchId: z.uuid(), name: branchName });
export const branchIdInput = z.strictObject({ branchId: z.uuid() });

const branchDto = (row: repo.BranchRow): BranchDto => ({ id: row.id, name: row.name, open: row.archivedAt === null });

async function audit(
  tx: TenantTx,
  ctx: TenantContext,
  action: string,
  branchId: string,
  before: object,
  after: object,
): Promise<void> {
  await repo.addAuditEntry(tx, ctx, {
    actorRole: await repo.actorRoleName(tx, ctx),
    action,
    entityType: "branch",
    entityId: branchId,
    before,
    after,
  });
}

export async function listBranches(ctx: TenantContext): Promise<BranchDto[]> {
  await requirePermission(ctx, "settings.manage");
  const rows = await withTenant(ctx, (tx) => repo.listBranches(tx));
  return rows.map(branchDto);
}

// Branch names for choosing where stock goes or comes from: anyone who
// works with stock, sales or reports (read-only; managing stays above).
export async function listBranchChoices(ctx: TenantContext): Promise<BranchDto[]> {
  await requirePermission(ctx, ["settings.manage", "stock.adjust", "purchases.create", "sales.create", "reports.view", "products.manage", "tills.manage"]);
  const rows = await withTenant(ctx, (tx) => repo.listBranches(tx));
  return rows.map(branchDto);
}

export async function createBranch(ctx: TenantContext, rawInput: unknown): Promise<BranchDto> {
  await requirePermission(ctx, "settings.manage");
  const { name } = createBranchInput.parse(rawInput);
  return withTenant(ctx, async (tx) => {
    // Specific answers first, then the plan (which locks and counts).
    if (await repo.branchNameTaken(tx, name, null)) throw new BranchError("NAME_TAKEN");
    await requireCapacity(tx, ctx, "branches");
    const id = await repo.insertBranch(tx, ctx, name);
    await audit(tx, ctx, "branch.created", id, {}, { name });
    return { id, name, open: true };
  });
}

export async function renameBranch(ctx: TenantContext, rawInput: unknown): Promise<BranchDto> {
  await requirePermission(ctx, "settings.manage");
  const { branchId, name } = renameBranchInput.parse(rawInput);
  return withTenant(ctx, async (tx) => {
    const branch = await repo.lockBranch(tx, branchId);
    if (branch === undefined) throw new BranchError("NOT_FOUND");
    if (branch.name === name) return branchDto(branch);
    if (await repo.branchNameTaken(tx, name, branch.id)) throw new BranchError("NAME_TAKEN");
    await repo.updateBranch(tx, branch, { name });
    await audit(tx, ctx, "branch.renamed", branch.id, { name: branch.name }, { name });
    return { ...branchDto(branch), name };
  });
}

export async function closeBranch(ctx: TenantContext, rawInput: unknown): Promise<BranchDto> {
  await requirePermission(ctx, "settings.manage");
  const { branchId } = branchIdInput.parse(rawInput);
  return withTenant(ctx, async (tx) => {
    await repo.lockBranchClosing(tx, ctx);
    const branch = await repo.lockBranch(tx, branchId);
    if (branch === undefined) throw new BranchError("NOT_FOUND");
    if (branch.archivedAt !== null) throw new BranchError("ALREADY_CLOSED");
    if ((await repo.countOpenBranches(tx, ctx)) <= 1) throw new BranchError("LAST_OPEN_BRANCH");
    await repo.updateBranch(tx, branch, { archivedAt: new Date() });
    await audit(tx, ctx, "branch.closed", branch.id, { open: true }, { open: false });
    return { ...branchDto(branch), open: false };
  });
}

export async function reopenBranch(ctx: TenantContext, rawInput: unknown): Promise<BranchDto> {
  await requirePermission(ctx, "settings.manage");
  const { branchId } = branchIdInput.parse(rawInput);
  return withTenant(ctx, async (tx) => {
    const branch = await repo.lockBranch(tx, branchId);
    if (branch === undefined) throw new BranchError("NOT_FOUND");
    if (branch.archivedAt === null) throw new BranchError("ALREADY_OPEN");
    // Reopening counts against the plan like adding.
    await requireCapacity(tx, ctx, "branches");
    await repo.updateBranch(tx, branch, { archivedAt: null });
    await audit(tx, ctx, "branch.reopened", branch.id, { open: false }, { open: true });
    return { ...branchDto(branch), open: true };
  });
}

// ---------------------------------------------------------------------------
// Shop type (clothing / mobile): may change only until the first product
// exists (owner decision 2026-10-02, business rules section 11).
// ---------------------------------------------------------------------------

export const changeShopTypeInput = z.strictObject({ template: z.enum(["clothing", "mobile"]), version: z.int().positive() });

export async function changeShopType(ctx: TenantContext, rawInput: unknown): Promise<{ changed: boolean; version: number }> {
  await requirePermission(ctx, "settings.manage");
  const input = changeShopTypeInput.parse(rawInput);
  return withTenant(ctx, async (tx) => {
    // The settings row lock also serialises this with profile saves.
    const current = await repo.lockProfile(tx, ctx);
    if (current === undefined) throw new SettingsError("NOT_FOUND");
    if (current.version !== input.version) throw new SettingsError("CHANGED_BY_SOMEONE_ELSE");
    if (current.template === input.template) return { changed: false, version: current.version };
    if (await repo.hasProducts(tx)) throw new SettingsError("LOCKED_BY_PRODUCTS");
    await repo.setTemplate(tx, ctx, input.template);
    const values: repo.ProfileValues = {
      businessName: current.businessName,
      addressLine1: current.addressLine1,
      addressLine2: current.addressLine2,
      city: current.city,
      stateCode: current.stateCode,
      pincode: current.pincode,
      phone: current.phone,
      contactEmail: current.contactEmail,
      gstRegistration: current.gstRegistration,
      gstin: current.gstin,
      pricesIncludeTax: current.pricesIncludeTax,
      invoicePrefix: current.invoicePrefix,
      creditNotePrefix: current.creditNotePrefix,
    };
    // Bump the settings version, so an open settings page cannot overwrite.
    await repo.saveProfile(tx, ctx, values, current.version + 1);
    await repo.addAuditEntry(tx, ctx, {
      actorRole: await repo.actorRoleName(tx, ctx),
      action: "settings.shop_type_changed",
      entityType: "tenant",
      entityId: ctx.tenantId,
      before: { template: current.template },
      after: { template: input.template },
    });
    return { changed: true, version: current.version + 1 };
  });
}
