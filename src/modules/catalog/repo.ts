import "server-only";
import { and, asc, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import {
  auditLogs,
  barcodes,
  brands,
  categories,
  memberships,
  products,
  productVariants,
  roles,
  taxCategories,
  tenants,
  units,
} from "@/db/schema";

// Database queries of the catalog module, inside the caller's withTenant
// transaction (row-level security limits them to the business).

export type ListKind = "category" | "brand" | "unit";

const tableOf = { category: categories, brand: brands, unit: units } as const;

export async function listCategories(tx: TenantTx) {
  return tx
    .select({ id: categories.id, name: categories.name, parentId: categories.parentId, archivedAt: categories.archivedAt })
    .from(categories)
    .orderBy(asc(categories.name));
}

export async function listBrands(tx: TenantTx) {
  return tx.select({ id: brands.id, name: brands.name, archivedAt: brands.archivedAt }).from(brands).orderBy(asc(brands.name));
}

export async function listUnits(tx: TenantTx) {
  return tx
    .select({ id: units.id, name: units.name, code: units.code, allowsFraction: units.allowsFraction, archivedAt: units.archivedAt })
    .from(units)
    .orderBy(asc(units.name));
}

// Any item of this kind (open or archived) already using the name, ignoring
// case.
export async function nameTaken(tx: TenantTx, kind: ListKind, name: string, exceptId: string | null): Promise<boolean> {
  const table = tableOf[kind];
  const rows = await tx.select({ id: table.id }).from(table).where(sql`lower(${table.name}) = lower(${name})`);
  return rows.some((r) => r.id !== exceptId);
}

export async function unitCodeTaken(tx: TenantTx, code: string): Promise<boolean> {
  const rows = await tx.select({ id: units.id }).from(units).where(sql`lower(${units.code}) = lower(${code})`);
  return rows.length > 0;
}

export async function lockItem(
  tx: TenantTx,
  kind: ListKind,
  id: string,
): Promise<{ id: string; name: string; archivedAt: Date | null; version: number } | undefined> {
  const table = tableOf[kind];
  const [row] = await tx
    .select({ id: table.id, name: table.name, archivedAt: table.archivedAt, version: table.version })
    .from(table)
    .where(eq(table.id, id))
    .for("update");
  return row;
}

export async function findCategory(tx: TenantTx, id: string) {
  const [row] = await tx
    .select({ id: categories.id, parentId: categories.parentId, archivedAt: categories.archivedAt })
    .from(categories)
    .where(eq(categories.id, id));
  return row;
}

export async function insertCategory(tx: TenantTx, ctx: TenantContext, name: string, parentId: string | null): Promise<string> {
  const [row] = await tx
    .insert(categories)
    .values({ tenantId: ctx.tenantId, name, parentId, createdBy: ctx.userId })
    .returning({ id: categories.id });
  if (row === undefined) throw new Error("category insert returned nothing");
  return row.id;
}

export async function insertBrand(tx: TenantTx, ctx: TenantContext, name: string): Promise<string> {
  const [row] = await tx.insert(brands).values({ tenantId: ctx.tenantId, name, createdBy: ctx.userId }).returning({ id: brands.id });
  if (row === undefined) throw new Error("brand insert returned nothing");
  return row.id;
}

export async function insertUnit(
  tx: TenantTx,
  ctx: TenantContext,
  values: { name: string; code: string; allowsFraction: boolean },
): Promise<string> {
  const [row] = await tx.insert(units).values({ tenantId: ctx.tenantId, createdBy: ctx.userId, ...values }).returning({ id: units.id });
  if (row === undefined) throw new Error("unit insert returned nothing");
  return row.id;
}

export async function updateItem(
  tx: TenantTx,
  kind: ListKind,
  item: { id: string; version: number },
  values: { name?: string; archivedAt?: Date | null },
): Promise<void> {
  const table = tableOf[kind];
  await tx
    .update(table)
    .set({ ...values, version: item.version + 1 })
    .where(eq(table.id, item.id));
}

export async function actorRoleName(tx: TenantTx, ctx: TenantContext): Promise<string> {
  const [row] = await tx
    .select({ name: roles.name })
    .from(memberships)
    .innerJoin(roles, and(eq(roles.tenantId, memberships.tenantId), eq(roles.id, memberships.roleId)))
    .where(eq(memberships.userId, ctx.userId));
  return row?.name ?? "unknown";
}

export async function addAuditEntry(
  tx: TenantTx,
  ctx: TenantContext,
  entry: { action: string; entityType: string; entityId: string; before: object | null; after: object | null },
): Promise<void> {
  await tx
    .insert(auditLogs)
    .values({ tenantId: ctx.tenantId, actorUserId: ctx.userId, actorRole: await actorRoleName(tx, ctx), ...entry });
}

// ---------------------------------------------------------------------------
// Products and variants.
// ---------------------------------------------------------------------------

export async function businessTemplate(tx: TenantTx): Promise<"clothing" | "mobile"> {
  const [row] = await tx.select({ template: tenants.template }).from(tenants);
  return row?.template === "mobile" ? "mobile" : "clothing";
}

// Is this list item there and not archived?
export async function listItemActive(tx: TenantTx, kind: ListKind, id: string): Promise<boolean> {
  const table = tableOf[kind];
  const rows = await tx.select({ id: table.id }).from(table).where(and(eq(table.id, id), isNull(table.archivedAt)));
  return rows.length > 0;
}

export async function unitAllowsFraction(tx: TenantTx, unitId: string): Promise<boolean | undefined> {
  const [row] = await tx.select({ f: units.allowsFraction }).from(units).where(eq(units.id, unitId));
  return row?.f;
}

export async function taxCategoryExists(tx: TenantTx, code: string): Promise<boolean> {
  const rows = await tx.select({ code: taxCategories.code }).from(taxCategories).where(eq(taxCategories.code, code));
  return rows.length > 0;
}

// SKUs already used in this business (ignoring case), apart from one variant.
export async function takenSkus(tx: TenantTx, skus: string[], exceptVariantId: string | null): Promise<string[]> {
  if (skus.length === 0) return [];
  const rows = await tx
    .select({ id: productVariants.id, sku: productVariants.sku })
    .from(productVariants)
    .where(inArray(sql`lower(${productVariants.sku})`, skus.map((x) => x.toLowerCase())));
  return rows.filter((r) => r.id !== exceptVariantId).map((r) => r.sku);
}

export interface ProductRow {
  id: string;
  name: string;
  categoryId: string | null;
  brandId: string | null;
  unitId: string;
  hsnCode: string | null;
  taxCategory: string;
  attributes: unknown;
  trackSerial: boolean;
  warrantyMonths: number | null;
  archivedAt: Date | null;
  version: number;
}

export interface VariantRow {
  id: string;
  productId: string;
  sku: string;
  attributes: unknown;
  sellingPricePaise: number;
  mrpPaise: number | null;
  costPricePaise: number | null;
  reorderLevel: string;
  position: number;
  archivedAt: Date | null;
  version: number;
}

const productColumns = {
  id: products.id,
  name: products.name,
  categoryId: products.categoryId,
  brandId: products.brandId,
  unitId: products.unitId,
  hsnCode: products.hsnCode,
  taxCategory: products.taxCategory,
  attributes: products.attributes,
  trackSerial: products.trackSerial,
  warrantyMonths: products.warrantyMonths,
  archivedAt: products.archivedAt,
  version: products.version,
};

const variantColumns = {
  id: productVariants.id,
  productId: productVariants.productId,
  sku: productVariants.sku,
  attributes: productVariants.attributes,
  sellingPricePaise: productVariants.sellingPricePaise,
  mrpPaise: productVariants.mrpPaise,
  costPricePaise: productVariants.costPricePaise,
  reorderLevel: productVariants.reorderLevel,
  position: productVariants.position,
  archivedAt: productVariants.archivedAt,
  version: productVariants.version,
};

export type NewProduct = Omit<ProductRow, "id" | "archivedAt" | "version">;
export type NewVariant = Omit<VariantRow, "id" | "productId" | "archivedAt" | "version">;

export async function insertProduct(tx: TenantTx, ctx: TenantContext, values: NewProduct): Promise<string> {
  const [row] = await tx
    .insert(products)
    .values({ tenantId: ctx.tenantId, createdBy: ctx.userId, ...values })
    .returning({ id: products.id });
  if (row === undefined) throw new Error("product insert returned nothing");
  return row.id;
}

export async function insertVariant(tx: TenantTx, ctx: TenantContext, productId: string, values: NewVariant): Promise<string> {
  const [row] = await tx
    .insert(productVariants)
    .values({ tenantId: ctx.tenantId, productId, createdBy: ctx.userId, ...values })
    .returning({ id: productVariants.id });
  if (row === undefined) throw new Error("variant insert returned nothing");
  return row.id;
}

export async function getProduct(tx: TenantTx, id: string): Promise<ProductRow | undefined> {
  const [row] = await tx.select(productColumns).from(products).where(eq(products.id, id));
  return row;
}

export async function lockProduct(tx: TenantTx, id: string): Promise<ProductRow | undefined> {
  const [row] = await tx.select(productColumns).from(products).where(eq(products.id, id)).for("update");
  return row;
}

export async function variantsOf(tx: TenantTx, productIds: string[]): Promise<VariantRow[]> {
  if (productIds.length === 0) return [];
  return tx
    .select(variantColumns)
    .from(productVariants)
    .where(inArray(productVariants.productId, productIds))
    .orderBy(asc(productVariants.position), asc(productVariants.createdAt), asc(productVariants.id));
}

export async function lockVariant(tx: TenantTx, id: string): Promise<VariantRow | undefined> {
  const [row] = await tx.select(variantColumns).from(productVariants).where(eq(productVariants.id, id)).for("update");
  return row;
}

export async function countActiveVariants(tx: TenantTx, productId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(productVariants)
    .where(and(eq(productVariants.productId, productId), isNull(productVariants.archivedAt)));
  return row?.n ?? 0;
}

export async function updateProduct(tx: TenantTx, product: ProductRow, values: Partial<NewProduct> & { archivedAt?: Date | null }): Promise<void> {
  await tx
    .update(products)
    .set({ ...values, version: product.version + 1 })
    .where(eq(products.id, product.id));
}

export async function updateVariant(tx: TenantTx, variant: VariantRow, values: Partial<NewVariant> & { archivedAt?: Date | null }): Promise<void> {
  await tx
    .update(productVariants)
    .set({ ...values, version: variant.version + 1 })
    .where(eq(productVariants.id, variant.id));
}

// Search: name contains, SKU starts with, or exact barcode. LIKE wildcards
// in the search text are escaped, so they are matched literally.
function searchFilter(q: string | null) {
  if (q === null) return undefined;
  const escaped = q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  return sql`(
    lower(${products.name}) LIKE ${`%${escaped}%`}
    OR EXISTS (SELECT 1 FROM ${productVariants} v WHERE v.product_id = ${products.id} AND lower(v.sku) LIKE ${`${escaped}%`})
    OR EXISTS (SELECT 1 FROM ${barcodes} b JOIN ${productVariants} v2 ON v2.id = b.variant_id
               WHERE v2.product_id = ${products.id} AND b.code = ${q} AND b.archived_at IS NULL)
  )`;
}

// A page of products, by name.
export async function listProducts(tx: TenantTx, limit: number, offset: number, q: string | null = null): Promise<ProductRow[]> {
  return tx
    .select(productColumns)
    .from(products)
    .where(searchFilter(q))
    .orderBy(asc(sql`lower(${products.name})`), asc(products.id))
    .limit(limit)
    .offset(offset);
}

export async function countProducts(tx: TenantTx, q: string | null = null): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(products).where(searchFilter(q));
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Barcodes.
// ---------------------------------------------------------------------------

export async function activeBarcodesOf(tx: TenantTx, variantIds: string[]) {
  if (variantIds.length === 0) return [];
  return tx
    .select({ id: barcodes.id, variantId: barcodes.variantId, code: barcodes.code })
    .from(barcodes)
    .where(and(inArray(barcodes.variantId, variantIds), isNull(barcodes.archivedAt)))
    .orderBy(asc(barcodes.createdAt), asc(barcodes.code));
}

export async function findActiveBarcode(tx: TenantTx, code: string) {
  const [row] = await tx
    .select({ id: barcodes.id, variantId: barcodes.variantId, productId: productVariants.productId })
    .from(barcodes)
    .innerJoin(productVariants, eq(productVariants.id, barcodes.variantId))
    .where(and(eq(barcodes.code, code), isNull(barcodes.archivedAt)));
  return row;
}

export async function insertBarcode(tx: TenantTx, ctx: TenantContext, variantId: string, code: string): Promise<string> {
  const [row] = await tx
    .insert(barcodes)
    .values({ tenantId: ctx.tenantId, variantId, code, createdBy: ctx.userId })
    .returning({ id: barcodes.id });
  if (row === undefined) throw new Error("barcode insert returned nothing");
  return row.id;
}

export async function lockBarcode(tx: TenantTx, id: string) {
  const [row] = await tx
    .select({ id: barcodes.id, code: barcodes.code, archivedAt: barcodes.archivedAt, version: barcodes.version })
    .from(barcodes)
    .where(eq(barcodes.id, id))
    .for("update");
  return row;
}

export async function archiveBarcode(tx: TenantTx, row: { id: string; version: number }): Promise<void> {
  await tx.update(barcodes).set({ archivedAt: new Date(), version: row.version + 1 }).where(eq(barcodes.id, row.id));
}

export async function listTaxCategories(tx: TenantTx) {
  return tx.select({ code: taxCategories.code, label: taxCategories.label }).from(taxCategories).orderBy(asc(taxCategories.label));
}

// Active list items for the CSV import, keyed by lower-case name / code.
export async function importLookups(tx: TenantTx) {
  const cats = await tx.select({ id: categories.id, name: categories.name }).from(categories).where(isNull(categories.archivedAt));
  const brs = await tx.select({ id: brands.id, name: brands.name }).from(brands).where(isNull(brands.archivedAt));
  const uns = await tx.select({ id: units.id, code: units.code }).from(units).where(isNull(units.archivedAt));
  const taxes = await tx.select({ code: taxCategories.code, label: taxCategories.label }).from(taxCategories);
  return {
    categories: new Map(cats.map((c) => [c.name.toLowerCase(), c.id])),
    brands: new Map(brs.map((b) => [b.name.toLowerCase(), b.id])),
    units: new Map(uns.map((u) => [u.code.toLowerCase(), u.id])),
    taxCategories: new Map(taxes.flatMap((t) => [[t.code.toLowerCase(), t.code], [t.label.toLowerCase(), t.code]] as [string, string][])),
  };
}

// Batch inserts for the CSV import (one round trip each).
export async function insertVariants(tx: TenantTx, ctx: TenantContext, productId: string, values: (NewVariant & { position: number })[]): Promise<string[]> {
  const rows = await tx
    .insert(productVariants)
    .values(values.map((v) => ({ tenantId: ctx.tenantId, productId, createdBy: ctx.userId, ...v })))
    .returning({ id: productVariants.id, position: productVariants.position });
  return rows.sort((a, b) => a.position - b.position).map((r) => r.id);
}

export async function insertBarcodes(tx: TenantTx, ctx: TenantContext, values: { variantId: string; code: string }[]): Promise<void> {
  if (values.length === 0) return;
  await tx.insert(barcodes).values(values.map((v) => ({ tenantId: ctx.tenantId, createdBy: ctx.userId, ...v })));
}

export async function addAuditEntryAs(
  tx: TenantTx,
  ctx: TenantContext,
  actorRole: string,
  entry: { action: string; entityType: string; entityId: string; before: object | null; after: object | null },
): Promise<void> {
  await tx.insert(auditLogs).values({ tenantId: ctx.tenantId, actorUserId: ctx.userId, actorRole, ...entry });
}

// Which of these codes are already active barcodes (one query).
export async function usedBarcodes(tx: TenantTx, codes: string[]): Promise<Set<string>> {
  if (codes.length === 0) return new Set();
  const rows = await tx
    .select({ code: barcodes.code })
    .from(barcodes)
    .where(and(inArray(barcodes.code, codes), isNull(barcodes.archivedAt)));
  return new Set(rows.map((r) => r.code));
}

// Items for stock and purchase screens: by id, or by an active barcode or
// SKU (case-insensitive). Archived items are included (history shows them).
export async function variantSummaries(tx: TenantTx, filter: { ids: string[] } | { codes: string[] }) {
  const where =
    "ids" in filter
      ? inArray(productVariants.id, filter.ids)
      : or(
          inArray(sql`upper(${productVariants.sku})`, filter.codes.map((c) => c.toUpperCase())),
          inArray(
            productVariants.id,
            tx.select({ id: barcodes.variantId }).from(barcodes).where(and(isNull(barcodes.archivedAt), inArray(barcodes.code, filter.codes))),
          ),
        );
  return tx
    .select({
      variantId: productVariants.id,
      productId: products.id,
      productName: products.name,
      sku: productVariants.sku,
      attributes: productVariants.attributes,
      trackSerial: products.trackSerial,
      unitCode: units.code,
      allowsFraction: units.allowsFraction,
      active: sql<boolean>`${productVariants.archivedAt} IS NULL AND ${products.archivedAt} IS NULL`,
      barcodes: sql<string[]>`coalesce((SELECT array_agg(b.code) FROM barcodes b WHERE b.variant_id = product_variants.id AND b.archived_at IS NULL), '{}')`,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(units, eq(units.id, products.unitId))
    .where(where);
}

// Everything a sale needs to know about its items, archived ones included
// (the sale refuses those itself).
export async function variantsForSale(tx: TenantTx, ids: string[]) {
  if (ids.length === 0) return [];
  return tx
    .select({
      variantId: productVariants.id,
      productName: products.name,
      attributes: productVariants.attributes,
      sku: productVariants.sku,
      hsnCode: products.hsnCode,
      unitCode: units.code,
      trackSerial: products.trackSerial,
      warrantyMonths: products.warrantyMonths,
      taxCategory: products.taxCategory,
      sellingPricePaise: productVariants.sellingPricePaise,
      active: sql<boolean>`${productVariants.archivedAt} IS NULL AND ${products.archivedAt} IS NULL`,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(units, eq(units.id, products.unitId))
    .where(inArray(productVariants.id, ids));
}
