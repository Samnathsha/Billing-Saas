import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { idColumn, mutableRowColumns, tenantIdColumn } from "@/db/columns";
import { taxCategories } from "@/modules/tax/schema";
import { branches, tenants } from "@/modules/tenants/schema";

// Lists that organise products (Phase 5). Archived, never deleted, so
// existing products keep them. Names unique per business, ignoring case
// (an archived name stays reserved).

export const categories = pgTable(
  "categories",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    // One level only (e.g. Men > Shirts): a parent never has a parent
    // itself (checked in the service; no loops possible).
    parentId: uuid("parent_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("categories_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("categories_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
    foreignKey({
      name: "categories_parent_fk",
      columns: [t.tenantId, t.parentId],
      foreignColumns: [t.tenantId, t.id],
    }).onDelete("restrict"),
    check("categories_name_length", sql`char_length(${t.name}) between 1 and 100`),
    check("categories_not_own_parent", sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
  ],
);

export const brands = pgTable(
  "brands",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("brands_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("brands_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
    check("brands_name_length", sql`char_length(${t.name}) between 1 and 100`),
  ],
);

export const units = pgTable(
  "units",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    // Short code printed on bills, e.g. "pcs", "m".
    code: text("code").notNull(),
    // Cloth sold by the metre: true; shirts: false (whole pieces only).
    allowsFraction: boolean("allows_fraction").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("units_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("units_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
    uniqueIndex("units_tenant_code_key").on(t.tenantId, sql`lower(${t.code})`),
    check("units_name_length", sql`char_length(${t.name}) between 1 and 50`),
    check("units_code_format", sql`${t.code} ~ '^[A-Za-z0-9.]{1,10}$'`),
  ],
);

// What the shop sells, before size/colour (blueprint 6.2, 6.4). Every
// product has at least one variant; archived, never deleted.
export const products = pgTable(
  "products",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    categoryId: uuid("category_id"),
    brandId: uuid("brand_id"),
    unitId: uuid("unit_id").notNull(),
    // 4, 6 or 8 digits (rule 4.6; open question 16).
    hsnCode: text("hsn_code"),
    taxCategory: text("tax_category")
      .notNull()
      .references(() => taxCategories.code, { onDelete: "restrict" }),
    // Template fields at product level (mobile: model), validated by the
    // template's Zod schema in the service.
    attributes: jsonb("attributes").notNull().default({}),
    // Mobile phones: each unit has an IMEI (serial_numbers, step 5.6).
    trackSerial: boolean("track_serial").notNull().default(false),
    warrantyMonths: integer("warranty_months"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("products_tenant_id_id_key").on(t.tenantId, t.id),
    index("products_tenant_name_idx").on(t.tenantId, sql`lower(${t.name}) text_pattern_ops`),
    foreignKey({ name: "products_category_fk", columns: [t.tenantId, t.categoryId], foreignColumns: [categories.tenantId, categories.id] }).onDelete("restrict"),
    foreignKey({ name: "products_brand_fk", columns: [t.tenantId, t.brandId], foreignColumns: [brands.tenantId, brands.id] }).onDelete("restrict"),
    foreignKey({ name: "products_unit_fk", columns: [t.tenantId, t.unitId], foreignColumns: [units.tenantId, units.id] }).onDelete("restrict"),
    check("products_name_length", sql`char_length(${t.name}) between 1 and 200`),
    check("products_hsn_format", sql`${t.hsnCode} ~ '^[0-9]{4}([0-9]{2}){0,2}$'`),
    check("products_warranty_range", sql`${t.warrantyMonths} between 0 and 120`),
    check("products_attributes_object", sql`jsonb_typeof(${t.attributes}) = 'object'`),
  ],
);

// The thing actually stocked and sold: e.g. "Shirt, blue, M". Money is
// integer paise (rule 1.2).
export const productVariants = pgTable(
  "product_variants",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    productId: uuid("product_id").notNull(),
    sku: text("sku").notNull(),
    // Template fields at variant level (clothing: size, colour, fabric).
    attributes: jsonb("attributes").notNull().default({}),
    sellingPricePaise: bigint("selling_price_paise", { mode: "number" }).notNull(),
    // Optional (open question 25); never below the selling price (open
    // question 30).
    mrpPaise: bigint("mrp_paise", { mode: "number" }),
    // Starting cost until purchases (business rules section 13); shown only
    // to "View cost price and profit".
    costPricePaise: bigint("cost_price_paise", { mode: "number" }),
    // Low-stock warning level, in the product's unit.
    reorderLevel: numeric("reorder_level", { precision: 14, scale: 3 }).notNull().default("0"),
    // Order within the product, as entered (e.g. S, M, L).
    position: integer("position").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("product_variants_tenant_id_id_key").on(t.tenantId, t.id),
    check("product_variants_position", sql`${t.position} >= 0`),
    uniqueIndex("product_variants_tenant_sku_key").on(t.tenantId, sql`lower(${t.sku})`),
    index("product_variants_tenant_product_idx").on(t.tenantId, t.productId),
    foreignKey({
      name: "product_variants_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete("restrict"),
    check("product_variants_sku_format", sql`${t.sku} ~ '^[A-Za-z0-9._/-]{1,40}$'`),
    // At least 1 paisa (open question 29), at most 1 crore rupees.
    check("product_variants_price_range", sql`${t.sellingPricePaise} between 1 and 1000000000`),
    check("product_variants_mrp", sql`${t.mrpPaise} IS NULL OR (${t.mrpPaise} >= ${t.sellingPricePaise} AND ${t.mrpPaise} <= 1000000000)`),
    check("product_variants_cost", sql`${t.costPricePaise} IS NULL OR ${t.costPricePaise} between 0 and 1000000000`),
    check("product_variants_reorder", sql`${t.reorderLevel} >= 0`),
    check("product_variants_attributes_object", sql`jsonb_typeof(${t.attributes}) = 'object'`),
  ],
);

// Barcodes (blueprint 6.3): a scan finds exactly one item. A variant may
// have several. Removing a barcode archives it, freeing the code for reuse.
export const barcodes = pgTable(
  "barcodes",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id").notNull(),
    code: text("code").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("barcodes_tenant_id_id_key").on(t.tenantId, t.id),
    // One active item per code in a business.
    uniqueIndex("barcodes_tenant_code_active_key").on(t.tenantId, t.code).where(sql`${t.archivedAt} IS NULL`),
    index("barcodes_tenant_variant_idx").on(t.tenantId, t.variantId),
    foreignKey({
      name: "barcodes_variant_fk",
      columns: [t.tenantId, t.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.id],
    }).onDelete("restrict"),
    check("barcodes_code_format", sql`${t.code} ~ '^[A-Za-z0-9-]{1,64}$'`),
  ],
);

// One row per physical unit of a serial-tracked product (IMEI), blueprint
// 6.3. Rows are created by purchases (Phase 6) and changed by sales and
// returns: an IMEI can be sold only once until it is returned.
export const serialNumbers = pgTable(
  "serial_numbers",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id").notNull(),
    serial: text("serial").notNull(),
    // 'in_stock' | 'sold' | 'returned' | 'scrapped'
    status: text("status").notNull().default("in_stock"),
    branchId: uuid("branch_id"),
    // Links to purchase and sale lines arrive with those tables (Phase 6-7).
    purchaseItemId: uuid("purchase_item_id"),
    invoiceItemId: uuid("invoice_item_id"),
    warrantyEndsOn: date("warranty_ends_on"),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("serial_numbers_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("serial_numbers_tenant_serial_key").on(t.tenantId, sql`upper(${t.serial})`),
    index("serial_numbers_tenant_variant_idx").on(t.tenantId, t.variantId),
    foreignKey({
      name: "serial_numbers_variant_fk",
      columns: [t.tenantId, t.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "serial_numbers_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("restrict"),
    check("serial_numbers_format", sql`${t.serial} ~ '^[A-Za-z0-9-]{4,40}$'`),
    check("serial_numbers_status_valid", sql`${t.status} in ('in_stock', 'sold', 'returned', 'scrapped')`),
  ],
);
