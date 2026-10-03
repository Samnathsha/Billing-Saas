import "server-only";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { requirePermission } from "@/modules/auth";
import * as repo from "./repo";

// Categories, brands and units (Phase 5, business rules section 13): need
// "Manage products" (Owner, Admin, Manager). Names unique per business
// ignoring case (archived names stay reserved); archived, never deleted;
// subcategories one level deep. Every change is audited.

export type CatalogErrorCode = "NAME_TAKEN" | "CODE_TAKEN" | "NOT_FOUND" | "PARENT_INVALID" | "ALREADY_ARCHIVED" | "NOT_ARCHIVED";

const MESSAGES: Record<CatalogErrorCode, string> = {
  NAME_TAKEN: "This name is already used (perhaps by an archived item).",
  CODE_TAKEN: "This unit code is already used.",
  NOT_FOUND: "This item was not found.",
  PARENT_INVALID: "Choose an active main category (subcategories go one level deep).",
  ALREADY_ARCHIVED: "This item is already archived.",
  NOT_ARCHIVED: "This item is not archived.",
};

export class CatalogError extends Error {
  constructor(public readonly code: CatalogErrorCode) {
    super(MESSAGES[code]);
    this.name = "CatalogError";
  }
}

export interface CatalogListsDto {
  categories: { id: string; name: string; parentId: string | null; active: boolean }[];
  brands: { id: string; name: string; active: boolean }[];
  units: { id: string; name: string; code: string; allowsFraction: boolean; active: boolean }[];
  taxCategories: { code: string; label: string }[];
  template: "clothing" | "mobile";
}

const name = (max: number) =>
  z.string().trim().min(1, { error: "Enter a name." }).max(max, { error: `Use at most ${String(max)} characters.` });

export const createCategoryInput = z.strictObject({
  name: name(100),
  parentId: z.preprocess((v) => (v === "" ? null : v), z.uuid().nullable()),
});
export const createBrandInput = z.strictObject({ name: name(100) });
export const createUnitInput = z.strictObject({
  name: name(50),
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9.]{1,10}$/, { error: "Use 1 to 10 letters, digits or dots, e.g. pcs." }),
  allowsFraction: z.boolean(),
});
const kind = z.enum(["category", "brand", "unit"]);
export const renameListItemInput = z.strictObject({ kind, id: z.uuid(), name: name(100) });
export const archiveListItemInput = z.strictObject({ kind, id: z.uuid(), archived: z.boolean() });

export async function getCatalogLists(ctx: TenantContext): Promise<CatalogListsDto> {
  await requirePermission(ctx, "products.manage");
  return withTenant(ctx, async (tx) => ({
    categories: (await repo.listCategories(tx)).map((c) => ({
      id: c.id,
      name: c.name,
      parentId: c.parentId,
      active: c.archivedAt === null,
    })),
    brands: (await repo.listBrands(tx)).map((b) => ({ id: b.id, name: b.name, active: b.archivedAt === null })),
    units: (await repo.listUnits(tx)).map((u) => ({
      id: u.id,
      name: u.name,
      code: u.code,
      allowsFraction: u.allowsFraction,
      active: u.archivedAt === null,
    })),
    taxCategories: await repo.listTaxCategories(tx),
    template: await repo.businessTemplate(tx),
  }));
}

export async function createCategory(ctx: TenantContext, rawInput: unknown): Promise<{ id: string }> {
  await requirePermission(ctx, "products.manage");
  const input = createCategoryInput.parse(rawInput);
  return withTenant(ctx, async (tx) => {
    if (input.parentId !== null) {
      const parent = await repo.findCategory(tx, input.parentId);
      if (parent === undefined || parent.archivedAt !== null || parent.parentId !== null) {
        throw new CatalogError("PARENT_INVALID");
      }
    }
    if (await repo.nameTaken(tx, "category", input.name, null)) throw new CatalogError("NAME_TAKEN");
    const id = await repo.insertCategory(tx, ctx, input.name, input.parentId);
    await repo.addAuditEntry(tx, ctx, { action: "catalog.category_created", entityType: "category", entityId: id, before: null, after: input });
    return { id };
  });
}

export async function createBrand(ctx: TenantContext, rawInput: unknown): Promise<{ id: string }> {
  await requirePermission(ctx, "products.manage");
  const input = createBrandInput.parse(rawInput);
  return withTenant(ctx, async (tx) => {
    if (await repo.nameTaken(tx, "brand", input.name, null)) throw new CatalogError("NAME_TAKEN");
    const id = await repo.insertBrand(tx, ctx, input.name);
    await repo.addAuditEntry(tx, ctx, { action: "catalog.brand_created", entityType: "brand", entityId: id, before: null, after: input });
    return { id };
  });
}

export async function createUnit(ctx: TenantContext, rawInput: unknown): Promise<{ id: string }> {
  await requirePermission(ctx, "products.manage");
  const input = createUnitInput.parse(rawInput);
  return withTenant(ctx, async (tx) => {
    if (await repo.nameTaken(tx, "unit", input.name, null)) throw new CatalogError("NAME_TAKEN");
    if (await repo.unitCodeTaken(tx, input.code)) throw new CatalogError("CODE_TAKEN");
    const id = await repo.insertUnit(tx, ctx, input);
    await repo.addAuditEntry(tx, ctx, { action: "catalog.unit_created", entityType: "unit", entityId: id, before: null, after: input });
    return { id };
  });
}

export async function renameListItem(ctx: TenantContext, rawInput: unknown): Promise<void> {
  await requirePermission(ctx, "products.manage");
  const input = renameListItemInput.parse(rawInput);
  await withTenant(ctx, async (tx) => {
    const item = await repo.lockItem(tx, input.kind, input.id);
    if (item === undefined) throw new CatalogError("NOT_FOUND");
    if (item.name === input.name) return;
    if (await repo.nameTaken(tx, input.kind, input.name, item.id)) throw new CatalogError("NAME_TAKEN");
    await repo.updateItem(tx, input.kind, item, { name: input.name });
    await repo.addAuditEntry(tx, ctx, {
      action: `catalog.${input.kind}_renamed`,
      entityType: input.kind,
      entityId: item.id,
      before: { name: item.name },
      after: { name: input.name },
    });
  });
}

export async function setListItemArchived(ctx: TenantContext, rawInput: unknown): Promise<void> {
  await requirePermission(ctx, "products.manage");
  const input = archiveListItemInput.parse(rawInput);
  await withTenant(ctx, async (tx) => {
    const item = await repo.lockItem(tx, input.kind, input.id);
    if (item === undefined) throw new CatalogError("NOT_FOUND");
    if (input.archived && item.archivedAt !== null) throw new CatalogError("ALREADY_ARCHIVED");
    if (!input.archived && item.archivedAt === null) throw new CatalogError("NOT_ARCHIVED");
    await repo.updateItem(tx, input.kind, item, { archivedAt: input.archived ? new Date() : null });
    await repo.addAuditEntry(tx, ctx, {
      action: `catalog.${input.kind}_${input.archived ? "archived" : "restored"}`,
      entityType: input.kind,
      entityId: item.id,
      before: { archived: !input.archived },
      after: { archived: input.archived },
    });
  });
}
