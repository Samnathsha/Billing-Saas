import "server-only";
import { z } from "zod";
import { withTenant, type TenantContext, type TenantTx } from "@/db/with-tenant";
import { hasPermission, PermissionDeniedError, requirePermission, type Permission } from "@/modules/auth";
import * as repo from "./repo";
import { attributesSchema, orderedAttributes, variantKey, variantLabel, type Attributes, type Template } from "./templates";

// Products and variants (blueprint Phase 5; business rules sections 1, 4,
// 13 and open questions 25, 29-31). Money is integer paise.
// - Creating or editing products: "Manage products". Setting or changing a
//   selling price also needs "Change a selling price"; a cost price also
//   needs "View cost price and profit".
// - Looking products up: anyone who sells, manages products or views
//   reports. Cost price is left out of the answer for anyone without "View
//   cost price and profit", so it never reaches their browser.
// - Every change is audited; price changes with old and new values.

const VIEW: readonly Permission[] = ["products.manage", "sales.create", "reports.view"];
const MAX_PAISE = 1_000_000_000;
const PAGE_SIZE = 50;

export type ProductErrorCode =
  | "NOT_FOUND"
  | "SKU_TAKEN"
  | "DUPLICATE_VARIANT"
  | "LIST_ITEM_INVALID"
  | "TAX_CATEGORY_UNKNOWN"
  | "SERIAL_NEEDS_WHOLE_UNIT"
  | "CHANGED_BY_SOMEONE_ELSE"
  | "LAST_ACTIVE_VARIANT"
  | "ALREADY_ARCHIVED"
  | "NOT_ARCHIVED";

const MESSAGES: Record<ProductErrorCode, string> = {
  NOT_FOUND: "This product was not found.",
  SKU_TAKEN: "This SKU is already used by another item.",
  DUPLICATE_VARIANT: "Two variants have the same details. Each variant must differ (e.g. size or colour).",
  LIST_ITEM_INVALID: "Choose an active category, brand and unit.",
  TAX_CATEGORY_UNKNOWN: "Choose a tax rate from the list.",
  SERIAL_NEEDS_WHOLE_UNIT: "IMEI/serial tracking needs a unit sold in whole pieces.",
  CHANGED_BY_SOMEONE_ELSE: "Someone else changed this meanwhile. Please reload and try again.",
  LAST_ACTIVE_VARIANT: "This is the last active variant. Archive the whole product instead.",
  ALREADY_ARCHIVED: "This is already archived.",
  NOT_ARCHIVED: "This is not archived.",
};

export class ProductError extends Error {
  constructor(
    public readonly code: ProductErrorCode,
    public readonly detail?: string,
  ) {
    super(detail === undefined ? MESSAGES[code] : `${MESSAGES[code]} (${detail})`);
    this.name = "ProductError";
  }
}

export interface VariantDto {
  id: string;
  sku: string;
  attributes: Attributes;
  label: string;
  sellingPricePaise: number;
  mrpPaise: number | null;
  // Present only for "View cost price and profit".
  costPricePaise?: number | null;
  reorderLevel: string;
  active: boolean;
  version: number;
}

export interface ProductDto {
  id: string;
  name: string;
  categoryId: string | null;
  brandId: string | null;
  unitId: string;
  hsnCode: string | null;
  taxCategory: string;
  attributes: Attributes;
  trackSerial: boolean;
  warrantyMonths: number | null;
  active: boolean;
  version: number;
  variants: VariantDto[];
}

// ---------------------------------------------------------------------------
// Input rules.
// ---------------------------------------------------------------------------

const optionalId = z.preprocess((v) => (v === "" ? null : v), z.uuid().nullable());
const paise = (min: number) =>
  z.int({ error: "Enter an amount in paise (whole number)." }).min(min, { error: "The price must be at least 1 paisa." }).max(MAX_PAISE, {
    error: "The amount is too large.",
  });
const optionalPaise = (min: number) => z.preprocess((v) => (v === "" ? null : v), paise(min).nullable());

const sku = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._/-]{1,40}$/, { error: "SKU: 1 to 40 letters, digits or . _ / -" });
const reorderLevel = z.preprocess(
  (v) => (v === "" || v === undefined ? "0" : typeof v === "number" ? String(v) : v),
  z.string().regex(/^[0-9]{1,11}(\.[0-9]{1,3})?$/, { error: "Reorder level: a number with at most 3 decimals." }),
);

const variantInput = z
  .strictObject({
    sku,
    attributes: z.record(z.string(), z.unknown()).default({}),
    sellingPricePaise: paise(1),
    mrpPaise: optionalPaise(1).optional(),
    costPricePaise: optionalPaise(0).optional(),
    reorderLevel: reorderLevel.optional(),
  })
  .refine((v) => v.mrpPaise === undefined || v.mrpPaise === null || v.mrpPaise >= v.sellingPricePaise, {
    error: "The selling price cannot be above the MRP.",
    path: ["mrpPaise"],
  });

const productFields = {
  name: z.string().trim().min(1, { error: "Enter the product name." }).max(200, { error: "Use at most 200 characters." }),
  categoryId: optionalId.optional(),
  brandId: optionalId.optional(),
  hsnCode: z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v),
    z
      .string()
      .regex(/^[0-9]{4}([0-9]{2}){0,2}$/, { error: "HSN code: 4, 6 or 8 digits." })
      .nullable()
      .optional(),
  ),
  taxCategory: z.string().regex(/^[a-z0-9_]{1,40}$/, { error: "Choose a tax rate." }),
  attributes: z.record(z.string(), z.unknown()).default({}),
  warrantyMonths: z.preprocess((v) => (v === "" ? null : v), z.int().min(0).max(120).nullable().optional()),
};

export const createProductInput = z.strictObject({
  ...productFields,
  unitId: z.uuid({ error: "Choose a unit." }),
  trackSerial: z.boolean().default(false),
  variants: z.array(variantInput).min(1, { error: "Add at least one variant." }).max(100, { error: "At most 100 variants." }),
});

export const updateProductInput = z.strictObject({ productId: z.uuid(), version: z.int().positive(), ...productFields });
export const addVariantInput = z.strictObject({ productId: z.uuid(), variant: variantInput });
export const updateVariantInput = z.strictObject({
  variantId: z.uuid(),
  version: z.int().positive(),
  sku,
  attributes: z.record(z.string(), z.unknown()).default({}),
  reorderLevel,
});
export const changePriceInput = z
  .strictObject({
    variantId: z.uuid(),
    version: z.int().positive(),
    sellingPricePaise: paise(1),
    mrpPaise: optionalPaise(1),
    // Left out = keep the current cost.
    costPricePaise: optionalPaise(0).optional(),
  })
  .refine((v) => v.mrpPaise === null || v.mrpPaise >= v.sellingPricePaise, {
    error: "The selling price cannot be above the MRP.",
    path: ["mrpPaise"],
  });
export const archiveInput = z.strictObject({ id: z.uuid(), archived: z.boolean() });
export const listProductsInput = z.strictObject({ page: z.int().min(1).max(10_000).default(1) });

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function parseAttributes(template: Template, level: "product" | "variant", raw: unknown, where: string): Attributes {
  const result = attributesSchema(template, level).safeParse(raw);
  if (!result.success) {
    throw new z.ZodError(result.error.issues.map((i) => ({ ...i, path: [where, ...i.path] })));
  }
  return result.data;
}

const asAttributes = (value: unknown): Attributes =>
  value !== null && typeof value === "object"
    ? Object.fromEntries<string>(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"))
    : {};

const isSet = <T,>(value: T | null | undefined): value is T => value !== null && value !== undefined;

function toVariantDto(v: repo.VariantRow, template: Template, showCost: boolean): VariantDto {
  const attributes = orderedAttributes(template, "variant", v.attributes);
  return {
    id: v.id,
    sku: v.sku,
    attributes,
    label: variantLabel(attributes),
    sellingPricePaise: v.sellingPricePaise,
    mrpPaise: v.mrpPaise,
    ...(showCost ? { costPricePaise: v.costPricePaise } : {}),
    reorderLevel: v.reorderLevel,
    active: v.archivedAt === null,
    version: v.version,
  };
}

function toProductDto(p: repo.ProductRow, variants: repo.VariantRow[], template: Template, showCost: boolean): ProductDto {
  return {
    id: p.id,
    name: p.name,
    categoryId: p.categoryId,
    brandId: p.brandId,
    unitId: p.unitId,
    hsnCode: p.hsnCode,
    taxCategory: p.taxCategory,
    attributes: orderedAttributes(template, "product", p.attributes),
    trackSerial: p.trackSerial,
    warrantyMonths: p.warrantyMonths,
    active: p.archivedAt === null,
    version: p.version,
    variants: variants.filter((v) => v.productId === p.id).map((v) => toVariantDto(v, template, showCost)),
  };
}

async function requireCostRight(ctx: TenantContext, wanted: boolean): Promise<void> {
  if (wanted && !(await hasPermission(ctx, "costs.view"))) throw new PermissionDeniedError("costs.view");
}

async function checkProductReferences(
  tx: TenantTx,
  refs: { categoryId?: string | null; brandId?: string | null; unitId?: string; taxCategory: string },
): Promise<void> {
  if (isSet(refs.categoryId) && !(await repo.listItemActive(tx, "category", refs.categoryId))) {
    throw new ProductError("LIST_ITEM_INVALID", "category");
  }
  if (isSet(refs.brandId) && !(await repo.listItemActive(tx, "brand", refs.brandId))) {
    throw new ProductError("LIST_ITEM_INVALID", "brand");
  }
  if (refs.unitId !== undefined && !(await repo.listItemActive(tx, "unit", refs.unitId))) {
    throw new ProductError("LIST_ITEM_INVALID", "unit");
  }
  if (!(await repo.taxCategoryExists(tx, refs.taxCategory))) throw new ProductError("TAX_CATEGORY_UNKNOWN");
}

async function checkSkusFree(tx: TenantTx, skus: string[], exceptVariantId: string | null): Promise<void> {
  const lower = skus.map((s) => s.toLowerCase());
  const repeated = lower.find((s, i) => lower.indexOf(s) !== i);
  if (repeated !== undefined) throw new ProductError("SKU_TAKEN", repeated);
  const taken = await repo.takenSkus(tx, skus, exceptVariantId);
  if (taken.length > 0) throw new ProductError("SKU_TAKEN", taken.join(", "));
}

function audit(tx: TenantTx, ctx: TenantContext, action: string, entityType: string, entityId: string, before: object | null, after: object | null) {
  return repo.addAuditEntry(tx, ctx, { action, entityType, entityId, before, after });
}

// ---------------------------------------------------------------------------
// Reading.
// ---------------------------------------------------------------------------

export async function getProduct(ctx: TenantContext, productId: string): Promise<ProductDto> {
  await requirePermission(ctx, VIEW);
  const id = z.uuid().parse(productId);
  const showCost = await hasPermission(ctx, "costs.view");
  return withTenant(ctx, async (tx) => {
    const product = await repo.getProduct(tx, id);
    if (product === undefined) throw new ProductError("NOT_FOUND");
    return toProductDto(product, await repo.variantsOf(tx, [id]), await repo.businessTemplate(tx), showCost);
  });
}

export async function listProducts(
  ctx: TenantContext,
  rawInput: unknown,
): Promise<{ products: ProductDto[]; page: number; pages: number; total: number }> {
  await requirePermission(ctx, VIEW);
  const { page } = listProductsInput.parse(rawInput);
  const showCost = await hasPermission(ctx, "costs.view");
  return withTenant(ctx, async (tx) => {
    const total = await repo.countProducts(tx);
    const rows = await repo.listProducts(tx, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    const variants = await repo.variantsOf(tx, rows.map((r) => r.id));
    const template = await repo.businessTemplate(tx);
    return {
      products: rows.map((p) => toProductDto(p, variants, template, showCost)),
      page,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      total,
    };
  });
}

// ---------------------------------------------------------------------------
// Writing.
// ---------------------------------------------------------------------------

export async function createProduct(ctx: TenantContext, rawInput: unknown): Promise<ProductDto> {
  await requirePermission(ctx, "products.manage");
  // Setting the first prices is setting a price.
  await requirePermission(ctx, "prices.change");
  const input = createProductInput.parse(rawInput);
  await requireCostRight(ctx, input.variants.some((v) => isSet(v.costPricePaise)));

  return withTenant(ctx, async (tx) => {
    const template = await repo.businessTemplate(tx);
    const attributes = parseAttributes(template, "product", input.attributes, "attributes");
    const variants = input.variants.map((v, i) => ({ ...v, attributes: parseAttributes(template, "variant", v.attributes, `variants.${String(i)}`) }));
    await checkProductReferences(tx, input);
    if (input.trackSerial && (await repo.unitAllowsFraction(tx, input.unitId)) !== false) {
      throw new ProductError("SERIAL_NEEDS_WHOLE_UNIT");
    }
    const keys = variants.map((v) => variantKey(v.attributes));
    if (new Set(keys).size !== keys.length) throw new ProductError("DUPLICATE_VARIANT");
    await checkSkusFree(tx, variants.map((v) => v.sku), null);

    const productId = await repo.insertProduct(tx, ctx, {
      name: input.name,
      categoryId: input.categoryId ?? null,
      brandId: input.brandId ?? null,
      unitId: input.unitId,
      hsnCode: input.hsnCode ?? null,
      taxCategory: input.taxCategory,
      attributes,
      trackSerial: input.trackSerial,
      warrantyMonths: input.warrantyMonths ?? null,
    });
    for (const [position, v] of variants.entries()) {
      await repo.insertVariant(tx, ctx, productId, {
        position,
        sku: v.sku,
        attributes: v.attributes,
        sellingPricePaise: v.sellingPricePaise,
        mrpPaise: v.mrpPaise ?? null,
        costPricePaise: v.costPricePaise ?? null,
        reorderLevel: v.reorderLevel ?? "0",
      });
    }
    await audit(tx, ctx, "product.created", "product", productId, null, { name: input.name, variants });
    const created = await repo.getProduct(tx, productId);
    if (created === undefined) throw new Error("created product not found");
    return toProductDto(created, await repo.variantsOf(tx, [productId]), template, await hasPermission(ctx, "costs.view"));
  });
}

export async function updateProduct(ctx: TenantContext, rawInput: unknown): Promise<{ version: number }> {
  await requirePermission(ctx, "products.manage");
  const input = updateProductInput.parse(rawInput);
  return withTenant(ctx, async (tx) => {
    const product = await repo.lockProduct(tx, input.productId);
    if (product === undefined) throw new ProductError("NOT_FOUND");
    if (product.version !== input.version) throw new ProductError("CHANGED_BY_SOMEONE_ELSE");
    const template = await repo.businessTemplate(tx);
    const values = {
      name: input.name,
      categoryId: input.categoryId ?? null,
      brandId: input.brandId ?? null,
      hsnCode: input.hsnCode ?? null,
      taxCategory: input.taxCategory,
      attributes: parseAttributes(template, "product", input.attributes, "attributes"),
      warrantyMonths: input.warrantyMonths ?? null,
    };
    // Only newly chosen list items must be active; a product may keep one
    // that was archived later.
    await checkProductReferences(tx, {
      categoryId: values.categoryId === product.categoryId ? null : values.categoryId,
      brandId: values.brandId === product.brandId ? null : values.brandId,
      taxCategory: values.taxCategory,
    });
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      const old = product[key as keyof typeof values];
      if (JSON.stringify(old) !== JSON.stringify(value)) {
        before[key] = old;
        after[key] = value;
      }
    }
    if (Object.keys(after).length === 0) return { version: product.version };
    await repo.updateProduct(tx, product, values);
    await audit(tx, ctx, "product.updated", "product", product.id, before, after);
    return { version: product.version + 1 };
  });
}

export async function addVariant(ctx: TenantContext, rawInput: unknown): Promise<{ variantId: string }> {
  await requirePermission(ctx, "products.manage");
  await requirePermission(ctx, "prices.change");
  const input = addVariantInput.parse(rawInput);
  await requireCostRight(ctx, isSet(input.variant.costPricePaise));
  return withTenant(ctx, async (tx) => {
    const product = await repo.lockProduct(tx, input.productId);
    if (product === undefined) throw new ProductError("NOT_FOUND");
    const attributes = parseAttributes(await repo.businessTemplate(tx), "variant", input.variant.attributes, "variant");
    const existing = await repo.variantsOf(tx, [product.id]);
    if (existing.some((v) => variantKey(asAttributes(v.attributes)) === variantKey(attributes))) {
      throw new ProductError("DUPLICATE_VARIANT");
    }
    await checkSkusFree(tx, [input.variant.sku], null);
    const variantId = await repo.insertVariant(tx, ctx, product.id, {
      position: existing.reduce((max, v) => Math.max(max, v.position + 1), 0),
      sku: input.variant.sku,
      attributes,
      sellingPricePaise: input.variant.sellingPricePaise,
      mrpPaise: input.variant.mrpPaise ?? null,
      costPricePaise: input.variant.costPricePaise ?? null,
      reorderLevel: input.variant.reorderLevel ?? "0",
    });
    await audit(tx, ctx, "product.variant_added", "product_variant", variantId, null, { productId: product.id, ...input.variant, attributes });
    return { variantId };
  });
}

export async function updateVariant(ctx: TenantContext, rawInput: unknown): Promise<{ version: number }> {
  await requirePermission(ctx, "products.manage");
  const input = updateVariantInput.parse(rawInput);
  return withTenant(ctx, async (tx) => {
    const variant = await repo.lockVariant(tx, input.variantId);
    if (variant === undefined) throw new ProductError("NOT_FOUND");
    if (variant.version !== input.version) throw new ProductError("CHANGED_BY_SOMEONE_ELSE");
    const attributes = parseAttributes(await repo.businessTemplate(tx), "variant", input.attributes, "attributes");
    const siblings = (await repo.variantsOf(tx, [variant.productId])).filter((v) => v.id !== variant.id);
    if (siblings.some((v) => variantKey(asAttributes(v.attributes)) === variantKey(attributes))) {
      throw new ProductError("DUPLICATE_VARIANT");
    }
    if (input.sku.toLowerCase() !== variant.sku.toLowerCase()) await checkSkusFree(tx, [input.sku], variant.id);
    const before = { sku: variant.sku, attributes: variant.attributes, reorderLevel: variant.reorderLevel };
    const after = { sku: input.sku, attributes, reorderLevel: input.reorderLevel };
    if (JSON.stringify(before) === JSON.stringify({ ...after, reorderLevel: Number(input.reorderLevel).toFixed(3) })) {
      return { version: variant.version };
    }
    await repo.updateVariant(tx, variant, after);
    await audit(tx, ctx, "product.variant_updated", "product_variant", variant.id, before, after);
    return { version: variant.version + 1 };
  });
}

// Price change: audited with old and new values. A sale stores its own
// price snapshot, so this never changes old invoices.
export async function changeVariantPrice(ctx: TenantContext, rawInput: unknown): Promise<{ version: number }> {
  await requirePermission(ctx, "prices.change");
  const input = changePriceInput.parse(rawInput);
  await requireCostRight(ctx, input.costPricePaise !== undefined);
  return withTenant(ctx, async (tx) => {
    const variant = await repo.lockVariant(tx, input.variantId);
    if (variant === undefined) throw new ProductError("NOT_FOUND");
    if (variant.version !== input.version) throw new ProductError("CHANGED_BY_SOMEONE_ELSE");
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const next = {
      sellingPricePaise: input.sellingPricePaise,
      mrpPaise: input.mrpPaise,
      ...(input.costPricePaise !== undefined ? { costPricePaise: input.costPricePaise } : {}),
    };
    for (const [key, value] of Object.entries(next)) {
      const old = variant[key as keyof typeof next];
      if (old !== value) {
        before[key] = old;
        after[key] = value;
      }
    }
    if (Object.keys(after).length === 0) return { version: variant.version };
    await repo.updateVariant(tx, variant, next);
    await audit(tx, ctx, "product.price_changed", "product_variant", variant.id, before, after);
    return { version: variant.version + 1 };
  });
}

export async function setProductArchived(ctx: TenantContext, rawInput: unknown): Promise<void> {
  await requirePermission(ctx, "products.manage");
  const { id, archived } = archiveInput.parse(rawInput);
  await withTenant(ctx, async (tx) => {
    const product = await repo.lockProduct(tx, id);
    if (product === undefined) throw new ProductError("NOT_FOUND");
    if (archived && product.archivedAt !== null) throw new ProductError("ALREADY_ARCHIVED");
    if (!archived && product.archivedAt === null) throw new ProductError("NOT_ARCHIVED");
    await repo.updateProduct(tx, product, { archivedAt: archived ? new Date() : null });
    await audit(tx, ctx, archived ? "product.archived" : "product.restored", "product", product.id, { archived: !archived }, { archived });
  });
}

export async function setVariantArchived(ctx: TenantContext, rawInput: unknown): Promise<void> {
  await requirePermission(ctx, "products.manage");
  const { id, archived } = archiveInput.parse(rawInput);
  await withTenant(ctx, async (tx) => {
    const variant = await repo.lockVariant(tx, id);
    if (variant === undefined) throw new ProductError("NOT_FOUND");
    if (archived && variant.archivedAt !== null) throw new ProductError("ALREADY_ARCHIVED");
    if (!archived && variant.archivedAt === null) throw new ProductError("NOT_ARCHIVED");
    if (archived) {
      // Lock the product too, so two archives cannot remove the last two.
      await repo.lockProduct(tx, variant.productId);
      if ((await repo.countActiveVariants(tx, variant.productId)) <= 1) throw new ProductError("LAST_ACTIVE_VARIANT");
    }
    await repo.updateVariant(tx, variant, { archivedAt: archived ? new Date() : null });
    await audit(tx, ctx, archived ? "product.variant_archived" : "product.variant_restored", "product_variant", variant.id, { archived: !archived }, { archived });
  });
}
