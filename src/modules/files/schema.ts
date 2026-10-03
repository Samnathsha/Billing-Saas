import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { idColumn, mutableRowColumns, tenantIdColumn } from "@/db/columns";
import { products } from "@/modules/catalog/schema";
import { tenants } from "@/modules/tenants/schema";

// Uploaded images (logo, product photos). The bytes live in private storage
// (R2 in production, a local folder in development) under a random,
// business-prefixed key; this row describes them. Archived, never deleted.
export const files = pgTable(
  "files",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    // 'logo' | 'product_image'
    purpose: text("purpose").notNull(),
    productId: uuid("product_id"),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sha256: text("sha256").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("files_tenant_id_id_key").on(t.tenantId, t.id),
    unique("files_storage_key_key").on(t.tenantId, t.storageKey),
    index("files_tenant_product_idx").on(t.tenantId, t.productId),
    foreignKey({ name: "files_product_fk", columns: [t.tenantId, t.productId], foreignColumns: [products.tenantId, products.id] }).onDelete("restrict"),
    check("files_purpose_valid", sql`${t.purpose} in ('logo', 'product_image')`),
    check("files_product_matches_purpose", sql`(${t.purpose} = 'product_image') = (${t.productId} IS NOT NULL)`),
    check("files_content_type_valid", sql`${t.contentType} in ('image/webp', 'image/png', 'image/jpeg')`),
    check("files_size_range", sql`${t.sizeBytes} between 1 and 2097152`),
    check("files_sha256_format", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("files_storage_key_format", sql`${t.storageKey} ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\\.webp$'`),
  ],
);
