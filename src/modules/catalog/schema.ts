import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { idColumn, mutableRowColumns, tenantIdColumn } from "@/db/columns";
import { tenants } from "@/modules/tenants/schema";

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
