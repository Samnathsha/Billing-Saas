import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, numeric, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, mutableRowColumns, tenantIdColumn } from "@/db/columns";
import { productVariants, serialNumbers } from "@/modules/catalog/schema";
import { branches, tenants } from "@/modules/tenants/schema";

// Stock (blueprint 6.2, 7.4; business rules 7 and 14). The movements are the
// source of truth: every change is a new row, never edited or deleted
// (database triggers block UPDATE/DELETE for everyone). The balances are a
// fast cache updated in the same transaction and rebuildable from the
// movements (scripts/rebuild-stock.ts compares the two).

export const MOVEMENT_TYPES = [
  "PURCHASE_IN",
  "SALE_OUT",
  "SALE_RETURN_IN",
  "PURCHASE_RETURN_OUT",
  "ADJUSTMENT_IN",
  "ADJUSTMENT_OUT",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "OPENING_STOCK",
  "VOID_REVERSAL",
] as const;

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").notNull(),
    variantId: uuid("variant_id").notNull(),
    movementType: text("movement_type").notNull(),
    // Signed: stock in > 0, stock out < 0 (checked per type).
    quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
    // Cost of one unit, in paise with 4 extra decimals (open question 24):
    // the purchase cost for stock in, the average cost at that moment for
    // stock out (rule 7.3), so profit reports stay stable.
    unitCostPaise: numeric("unit_cost_paise", { precision: 18, scale: 4 }).notNull(),
    // Required for adjustments (damaged, lost, found, count, expired, other).
    reasonCode: text("reason_code"),
    note: text("note"),
    // What caused it, e.g. ('purchase', purchase id, purchase line id).
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    sourceLineId: uuid("source_line_id").notNull(),
    serialNumberId: uuid("serial_number_id"),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAtColumn(),
    // The order in which movements were applied. Taken at insert, while the
    // balance row is locked, so for one item and branch it always follows
    // the real order (created_at is the transaction's START time and can
    // be out of order). Used to replay the ledger (scripts/rebuild-stock.ts).
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
  },
  (t) => [
    unique("stock_movements_tenant_id_id_key").on(t.tenantId, t.id),
    // A retried operation cannot post the same line twice.
    // NULLS NOT DISTINCT: without it, rows with no serial number would never
    // count as duplicates (an empty value is never equal to another).
    unique("stock_movements_source_key")
      .on(t.tenantId, t.sourceType, t.sourceLineId, t.movementType, t.serialNumberId)
      .nullsNotDistinct(),
    index("stock_movements_tenant_variant_idx").on(t.tenantId, t.variantId, t.branchId, t.seq),
    foreignKey({ name: "stock_movements_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }).onDelete("restrict"),
    foreignKey({ name: "stock_movements_variant_fk", columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }).onDelete("restrict"),
    foreignKey({ name: "stock_movements_serial_fk", columns: [t.tenantId, t.serialNumberId], foreignColumns: [serialNumbers.tenantId, serialNumbers.id] }).onDelete("restrict"),
    check(
      "stock_movements_type_valid",
      sql`${t.movementType} in ('PURCHASE_IN','SALE_OUT','SALE_RETURN_IN','PURCHASE_RETURN_OUT','ADJUSTMENT_IN','ADJUSTMENT_OUT','TRANSFER_IN','TRANSFER_OUT','OPENING_STOCK','VOID_REVERSAL')`,
    ),
    check(
      "stock_movements_sign",
      sql`${t.quantity} <> 0 AND (
        (${t.movementType} in ('PURCHASE_IN','SALE_RETURN_IN','ADJUSTMENT_IN','TRANSFER_IN','OPENING_STOCK') AND ${t.quantity} > 0)
        OR (${t.movementType} in ('SALE_OUT','PURCHASE_RETURN_OUT','ADJUSTMENT_OUT','TRANSFER_OUT') AND ${t.quantity} < 0)
        OR ${t.movementType} = 'VOID_REVERSAL')`,
    ),
    check("stock_movements_cost", sql`${t.unitCostPaise} >= 0`),
    check(
      "stock_movements_reason",
      sql`(${t.movementType} in ('ADJUSTMENT_IN','ADJUSTMENT_OUT')) = (${t.reasonCode} IS NOT NULL)
          AND (${t.reasonCode} IS NULL OR ${t.reasonCode} in ('damaged','lost','found','count_correction','expired','other'))`,
    ),
    check("stock_movements_serial_one_unit", sql`${t.serialNumberId} IS NULL OR abs(${t.quantity}) = 1`),
    check("stock_movements_note_length", sql`char_length(${t.note}) <= 500`),
    check("stock_movements_source_type", sql`${t.sourceType} ~ '^[a-z_]{1,40}$'`),
  ],
);

export const stockBalances = pgTable(
  "stock_balances",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull().default("0"),
    averageCostPaise: numeric("average_cost_paise", { precision: 18, scale: 4 }).notNull().default("0"),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("stock_balances_tenant_id_id_key").on(t.tenantId, t.id),
    unique("stock_balances_variant_branch_key").on(t.tenantId, t.variantId, t.branchId),
    foreignKey({ name: "stock_balances_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }).onDelete("restrict"),
    foreignKey({ name: "stock_balances_variant_fk", columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }).onDelete("restrict"),
    // Never below zero (rule 7.1); offline overselling arrives with Phase 10.
    check("stock_balances_not_negative", sql`${t.quantity} >= 0`),
    check("stock_balances_cost", sql`${t.averageCostPaise} >= 0`),
  ],
);

export type MovementType = (typeof MOVEMENT_TYPES)[number];
