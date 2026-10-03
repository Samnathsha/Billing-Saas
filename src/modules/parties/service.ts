import "server-only";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { requirePermission, type Permission } from "@/modules/auth";
import { claimIdempotencyKey } from "@/modules/sync";
import { gstinProblem, isGstStateCode, normaliseGstin } from "@/modules/tax";
import { PartyError } from "./errors";
import * as repo from "./repo";

// Suppliers (blueprint Phase 6). Managed with "Create purchase". A
// supplier's balance (what we owe) is never typed in or stored: it is the
// sum of append-only ledger rows (purchases, payments, voids, opening
// balance). Suppliers are archived, never deleted. Every change is audited.

const VIEW: readonly Permission[] = ["purchases.create", "reports.view"];
const MAX_PAISE = 100_000_000_000; // ₹100 crore

export interface SupplierDto {
  id: string;
  name: string;
  phone: string | null;
  gstin: string | null;
  stateCode: string | null;
  active: boolean;
  version: number;
  // What we owe the supplier; negative = the supplier owes us (advance).
  balancePaise: number;
}

export interface SupplierStatementDto {
  supplier: SupplierDto;
  entries: { id: string; entryType: string; amountPaise: number; sourceType: string; sourceId: string; note: string | null; createdAt: string }[];
}

const optionalText = <T extends z.ZodType<string | null, string>>(schema: T) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), schema.nullable());

const supplierFields = {
  name: z.string().trim().min(1, { error: "Enter the supplier's name." }).max(200, { error: "Use at most 200 characters." }),
  phone: optionalText(z.string().trim().regex(/^[+0-9 -]{6,20}$/, { error: "Enter a phone number (digits, spaces, + or -)." })),
  gstin: optionalText(z.string().transform(normaliseGstin)),
  stateCode: optionalText(z.string().trim()),
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
  if (input.stateCode !== null && !isGstStateCode(input.stateCode)) {
    issue.addIssue({ code: "custom", path: ["stateCode"], message: "Choose a state." });
  }
}

export const createSupplierInput = z.strictObject(supplierFields).superRefine(checkGst);
export const updateSupplierInput = z.strictObject({ id: z.uuid(), version: z.int().min(1), ...supplierFields }).superRefine(checkGst);
export const archiveSupplierInput = z.strictObject({ id: z.uuid(), archived: z.boolean() });
export const listSuppliersInput = z.strictObject({
  includeArchived: z.boolean().default(false),
  q: optionalText(z.string().trim().max(100)).default(null),
});
export const openingBalanceInput = z.strictObject({
  idempotencyKey: z.uuid(),
  supplierId: z.uuid(),
  // What we owed the supplier on the day we started; negative = advance paid.
  amountPaise: z
    .int()
    .min(-MAX_PAISE)
    .max(MAX_PAISE)
    .refine((v) => v !== 0, { error: "Enter an amount other than zero." }),
  note: optionalText(z.string().trim().max(500)).default(null),
});

// The state comes from the GSTIN when there is one.
const values = (input: z.infer<typeof createSupplierInput>): repo.SupplierValues => ({
  name: input.name,
  phone: input.phone,
  gstin: input.gstin,
  stateCode: input.gstin !== null ? input.gstin.slice(0, 2) : input.stateCode,
});

const toDto = (row: Awaited<ReturnType<typeof repo.listSuppliers>>[number]): SupplierDto => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  gstin: row.gstin,
  stateCode: row.stateCode,
  active: row.archivedAt === null,
  version: row.version,
  balancePaise: Number(row.balancePaise),
});

export async function createSupplier(ctx: TenantContext, rawInput: unknown): Promise<{ id: string }> {
  await requirePermission(ctx, "purchases.create");
  const input = values(createSupplierInput.parse(rawInput));
  return withTenant(ctx, async (tx) => {
    if (await repo.nameTaken(tx, input.name, null)) throw new PartyError("NAME_TAKEN");
    const id = await repo.insertSupplier(tx, ctx, input);
    await repo.addAuditEntry(tx, ctx, { action: "parties.supplier_created", entityType: "supplier", entityId: id, before: null, after: input });
    return { id };
  });
}

export async function updateSupplier(ctx: TenantContext, rawInput: unknown): Promise<void> {
  await requirePermission(ctx, "purchases.create");
  const parsed = updateSupplierInput.parse(rawInput);
  const input = values(parsed);
  await withTenant(ctx, async (tx) => {
    const row = await repo.lockSupplier(tx, parsed.id);
    if (row === undefined) throw new PartyError("NOT_FOUND");
    if (row.version !== parsed.version) throw new PartyError("STALE");
    if (input.name.toLowerCase() !== row.name.toLowerCase() && (await repo.nameTaken(tx, input.name, row.id))) throw new PartyError("NAME_TAKEN");
    await repo.updateSupplier(tx, row, input);
    const before = { name: row.name, phone: row.phone, gstin: row.gstin, stateCode: row.stateCode };
    await repo.addAuditEntry(tx, ctx, { action: "parties.supplier_updated", entityType: "supplier", entityId: row.id, before, after: input });
  });
}

export async function setSupplierArchived(ctx: TenantContext, rawInput: unknown): Promise<void> {
  await requirePermission(ctx, "purchases.create");
  const input = archiveSupplierInput.parse(rawInput);
  await withTenant(ctx, async (tx) => {
    const row = await repo.lockSupplier(tx, input.id);
    if (row === undefined) throw new PartyError("NOT_FOUND");
    if ((row.archivedAt !== null) === input.archived) return;
    await repo.updateSupplier(tx, row, { archivedAt: input.archived ? new Date() : null });
    await repo.addAuditEntry(tx, ctx, {
      action: input.archived ? "parties.supplier_archived" : "parties.supplier_restored",
      entityType: "supplier",
      entityId: row.id,
      before: { active: row.archivedAt === null },
      after: { active: !input.archived },
    });
  });
}

export async function listSuppliers(ctx: TenantContext, rawInput: unknown = {}): Promise<SupplierDto[]> {
  await requirePermission(ctx, VIEW);
  const input = listSuppliersInput.parse(rawInput);
  const rows = await withTenant(ctx, (tx) => repo.listSuppliers(tx, input));
  return rows.map(toDto);
}

export async function getSupplierStatement(ctx: TenantContext, rawInput: unknown): Promise<SupplierStatementDto> {
  await requirePermission(ctx, VIEW);
  const { supplierId } = z.strictObject({ supplierId: z.uuid() }).parse(rawInput);
  return withTenant(ctx, async (tx) => {
    const row = await repo.lockSupplier(tx, supplierId);
    if (row === undefined) throw new PartyError("NOT_FOUND");
    const balancePaise = await repo.supplierBalance(tx, supplierId);
    const entries = await repo.ledgerOf(tx, supplierId);
    return {
      supplier: toDto({ ...row, balancePaise }),
      entries: entries.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    };
  });
}

export async function recordSupplierOpeningBalance(ctx: TenantContext, rawInput: unknown): Promise<{ supplierId: string }> {
  await requirePermission(ctx, "purchases.create");
  const input = openingBalanceInput.parse(rawInput);
  return withTenant(ctx, async (tx) => {
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "parties.supplier_opening", { supplierId: input.supplierId });
    if (!claim.claimed) return claim.result;
    if ((await repo.lockSupplier(tx, input.supplierId)) === undefined) throw new PartyError("NOT_FOUND");
    const booked = await repo.insertLedgerEntry(tx, ctx, {
      supplierId: input.supplierId,
      entryType: "opening",
      amountPaise: input.amountPaise,
      sourceType: "supplier_opening",
      sourceId: input.supplierId,
      note: input.note,
    });
    if (!booked) throw new PartyError("OPENING_ALREADY_SET");
    await repo.addAuditEntry(tx, ctx, { action: "parties.supplier_opening_recorded", entityType: "supplier", entityId: input.supplierId, before: null, after: input });
    return { supplierId: input.supplierId };
  });
}
