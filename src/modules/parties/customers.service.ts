import "server-only";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { hasPermission, requirePermission, type Permission } from "@/modules/auth";
import { gstinProblem, isGstStateCode, normaliseGstin } from "@/modules/tax";
import { PartyError } from "./errors";
import * as repo from "./repo";

// Basic customers (business rules 15). Anyone who sells may add a customer
// at the till; giving credit (a limit above zero) needs "Discount above
// limit" (Manager and above), as credit is money given away (open question
// 39). Balance = sum of the append-only ledger, never typed in. Archived,
// never deleted. Every change audited.

const VIEW: readonly Permission[] = ["sales.create", "reports.view", "settings.manage"];
const MAX_PAISE = 100_000_000_000;

export interface CustomerDto {
  id: string;
  name: string;
  phone: string | null;
  gstin: string | null;
  stateCode: string | null;
  address: string | null;
  creditLimitPaise: number;
  // What the customer owes us; negative = we owe them (advance).
  balancePaise: number;
  active: boolean;
  version: number;
}

const optional = <T extends z.ZodType<string | null, string>>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), schema.nullable());

const fields = {
  name: z.string().trim().min(1, { error: "Enter the customer's name." }).max(200),
  phone: optional(z.string().trim().regex(/^[+0-9 -]{6,20}$/, { error: "Enter a phone number (digits, spaces, + or -)." })),
  gstin: optional(z.string().transform(normaliseGstin)),
  stateCode: optional(z.string().trim()),
  address: optional(z.string().trim().max(500, { error: "Use at most 500 characters." })).default(null),
  creditLimitPaise: z.int({ error: "Enter the credit limit in paise." }).min(0).max(MAX_PAISE).default(0),
};

function checkGst(input: { gstin: string | null; stateCode: string | null }, issue: z.core.$RefinementCtx): void {
  if (input.gstin !== null) {
    const problem = gstinProblem(input.gstin);
    if (problem !== null) {
      issue.addIssue({ code: "custom", path: ["gstin"], message: problem === "CHECK_CHARACTER" ? "This GSTIN has a typing mistake (check character)." : "Enter a valid 15-character GSTIN." });
    } else if (input.stateCode !== null && input.stateCode !== input.gstin.slice(0, 2)) {
      issue.addIssue({ code: "custom", path: ["stateCode"], message: "The state does not match the GSTIN." });
    }
  }
  if (input.stateCode !== null && !isGstStateCode(input.stateCode)) issue.addIssue({ code: "custom", path: ["stateCode"], message: "Choose a state." });
}

export const createCustomerInput = z.strictObject(fields).superRefine(checkGst);
export const updateCustomerInput = z.strictObject({ id: z.uuid(), version: z.int().min(1), ...fields }).superRefine(checkGst);

const values = (input: z.infer<typeof createCustomerInput>): repo.CustomerValues => ({
  name: input.name,
  phone: input.phone,
  gstin: input.gstin,
  stateCode: input.gstin !== null ? input.gstin.slice(0, 2) : input.stateCode,
  address: input.address,
  creditLimitPaise: input.creditLimitPaise,
});

type Row = NonNullable<Awaited<ReturnType<typeof repo.lockCustomer>>>;
const toCustomerDto = (row: Row): CustomerDto => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  gstin: row.gstin,
  stateCode: row.stateCode,
  address: row.address,
  creditLimitPaise: row.creditLimitPaise,
  balancePaise: Number(row.balancePaise),
  active: row.archivedAt === null,
  version: row.version,
});

export async function createCustomer(ctx: TenantContext, rawInput: unknown): Promise<{ id: string }> {
  await requirePermission(ctx, "sales.create");
  const input = values(createCustomerInput.parse(rawInput));
  if (input.creditLimitPaise > 0) await requirePermission(ctx, "discounts.above_limit");
  return withTenant(ctx, async (tx) => {
    if (input.phone !== null && (await repo.customerPhoneTaken(tx, input.phone, null))) throw new PartyError("PHONE_TAKEN");
    const id = await repo.insertCustomer(tx, ctx, input);
    await repo.addAuditEntry(tx, ctx, { action: "parties.customer_created", entityType: "customer", entityId: id, before: null, after: input });
    return { id };
  });
}

export async function updateCustomer(ctx: TenantContext, rawInput: unknown): Promise<void> {
  await requirePermission(ctx, "sales.create");
  const parsed = updateCustomerInput.parse(rawInput);
  const input = values(parsed);
  const mayGiveCredit = await hasPermission(ctx, "discounts.above_limit");
  await withTenant(ctx, async (tx) => {
    const row = await repo.lockCustomer(tx, parsed.id);
    if (row === undefined) throw new PartyError("NOT_FOUND");
    if (row.version !== parsed.version) throw new PartyError("STALE");
    if (input.creditLimitPaise !== row.creditLimitPaise && !mayGiveCredit) throw new PartyError("CREDIT_NOT_ALLOWED");
    if (input.phone !== null && input.phone !== row.phone && (await repo.customerPhoneTaken(tx, input.phone, row.id))) throw new PartyError("PHONE_TAKEN");
    await repo.updateCustomer(tx, row, input);
    const before = { name: row.name, phone: row.phone, gstin: row.gstin, stateCode: row.stateCode, address: row.address, creditLimitPaise: row.creditLimitPaise };
    await repo.addAuditEntry(tx, ctx, { action: "parties.customer_updated", entityType: "customer", entityId: row.id, before, after: input });
  });
}

export async function setCustomerArchived(ctx: TenantContext, rawInput: unknown): Promise<void> {
  await requirePermission(ctx, "discounts.above_limit");
  const input = z.strictObject({ id: z.uuid(), archived: z.boolean() }).parse(rawInput);
  await withTenant(ctx, async (tx) => {
    const row = await repo.lockCustomer(tx, input.id);
    if (row === undefined) throw new PartyError("NOT_FOUND");
    if ((row.archivedAt !== null) === input.archived) return;
    await repo.updateCustomer(tx, row, { archivedAt: input.archived ? new Date() : null });
    await repo.addAuditEntry(tx, ctx, {
      action: input.archived ? "parties.customer_archived" : "parties.customer_restored",
      entityType: "customer",
      entityId: row.id,
      before: { active: row.archivedAt === null },
      after: { active: !input.archived },
    });
  });
}

export async function listCustomers(ctx: TenantContext, rawInput: unknown = {}): Promise<CustomerDto[]> {
  await requirePermission(ctx, VIEW);
  const input = z
    .strictObject({
      includeArchived: z.boolean().default(false),
      q: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(100).nullable()).default(null),
    })
    .parse(rawInput);
  const rows = await withTenant(ctx, (tx) => repo.listCustomers(tx, input));
  return rows.map(toCustomerDto);
}

export async function getCustomer(ctx: TenantContext, rawInput: unknown): Promise<CustomerDto> {
  await requirePermission(ctx, VIEW);
  const { id } = z.strictObject({ id: z.uuid() }).parse(rawInput);
  const row = await withTenant(ctx, (tx) => repo.lockCustomer(tx, id));
  if (row === undefined) throw new PartyError("NOT_FOUND");
  return toCustomerDto(row);
}
