import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, numeric, pgTable, smallint, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, tenantIdColumn } from "@/db/columns";
import { productVariants } from "@/modules/catalog/schema";
import { suppliers } from "@/modules/parties/schema";
import { branches, tenants } from "@/modules/tenants/schema";

// Purchases (blueprint 6.2, 7.6; business rules 14). A posted purchase is
// never edited: the only change allowed is voiding it (database trigger).
// Items and supplier payments are append-only. Money in integer paise.

export const purchases = pgTable(
  "purchases",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    supplierId: uuid("supplier_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    supplierInvoiceNumber: text("supplier_invoice_number").notNull(),
    invoiceDate: date("invoice_date").notNull(),
    // 'posted' | 'voided'
    status: text("status").notNull().default("posted"),
    subtotalPaise: bigint("subtotal_paise", { mode: "number" }).notNull(),
    taxPaise: bigint("tax_paise", { mode: "number" }).notNull(),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    // Whether the cost of these items excludes GST (registered business) or
    // includes it (composition / unregistered), as decided at posting.
    costBasis: text("cost_basis").notNull(),
    note: text("note"),
    voidReason: text("void_reason"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique("purchases_tenant_id_id_key").on(t.tenantId, t.id),
    // The same supplier bill cannot be entered twice (while not voided).
    uniqueIndex("purchases_supplier_invoice_key")
      .on(t.tenantId, t.supplierId, sql`upper(${t.supplierInvoiceNumber})`)
      .where(sql`${t.status} = 'posted'`),
    index("purchases_tenant_date_idx").on(t.tenantId, t.invoiceDate),
    foreignKey({ name: "purchases_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }).onDelete("restrict"),
    foreignKey({ name: "purchases_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }).onDelete("restrict"),
    check("purchases_status_valid", sql`${t.status} in ('posted', 'voided')`),
    check("purchases_totals", sql`${t.subtotalPaise} >= 0 AND ${t.taxPaise} >= 0 AND ${t.totalPaise} = ${t.subtotalPaise} + ${t.taxPaise}`),
    check("purchases_cost_basis", sql`${t.costBasis} in ('excludes_tax', 'includes_tax')`),
    check("purchases_invoice_number", sql`char_length(${t.supplierInvoiceNumber}) between 1 and 40`),
    check("purchases_void_fields", sql`(${t.status} = 'voided') = (${t.voidReason} IS NOT NULL AND ${t.voidedAt} IS NOT NULL AND ${t.voidedBy} IS NOT NULL)`),
    check("purchases_text_lengths", sql`char_length(${t.note}) <= 500 AND char_length(${t.voidReason}) <= 500`),
  ],
);

export const purchaseItems = pgTable(
  "purchase_items",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    purchaseId: uuid("purchase_id").notNull(),
    // 1, 2, 3... in the order of the supplier's bill.
    lineNumber: smallint("line_number").notNull(),
    variantId: uuid("variant_id").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
    // Supplier's price per unit before GST, and the GST rate used.
    unitPricePaise: bigint("unit_price_paise", { mode: "number" }).notNull(),
    taxRate: numeric("tax_rate", { precision: 7, scale: 4 }).notNull(),
    lineSubtotalPaise: bigint("line_subtotal_paise", { mode: "number" }).notNull(),
    lineTaxPaise: bigint("line_tax_paise", { mode: "number" }).notNull(),
    lineTotalPaise: bigint("line_total_paise", { mode: "number" }).notNull(),
    // Cost per unit that goes into stock (rule 14), 4 decimals of a paisa.
    unitCostPaise: numeric("unit_cost_paise", { precision: 18, scale: 4 }).notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique("purchase_items_tenant_id_id_key").on(t.tenantId, t.id),
    unique("purchase_items_line_key").on(t.tenantId, t.purchaseId, t.lineNumber),
    foreignKey({ name: "purchase_items_purchase_fk", columns: [t.tenantId, t.purchaseId], foreignColumns: [purchases.tenantId, purchases.id] }).onDelete("restrict"),
    foreignKey({ name: "purchase_items_variant_fk", columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }).onDelete("restrict"),
    check("purchase_items_line_number", sql`${t.lineNumber} between 1 and 200`),
    check("purchase_items_quantity", sql`${t.quantity} > 0`),
    check("purchase_items_price", sql`${t.unitPricePaise} >= 0`),
    check("purchase_items_rate", sql`${t.taxRate} >= 0 AND ${t.taxRate} <= 100`),
    check("purchase_items_totals", sql`${t.lineTaxPaise} >= 0 AND ${t.lineTotalPaise} = ${t.lineSubtotalPaise} + ${t.lineTaxPaise}`),
    check("purchase_items_cost", sql`${t.unitCostPaise} >= 0`),
  ],
);

// Money paid to a supplier: at a purchase or later. Append-only.
export const supplierPayments = pgTable(
  "supplier_payments",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    supplierId: uuid("supplier_id").notNull(),
    purchaseId: uuid("purchase_id"),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    // 'cash' | 'upi' | 'bank' | 'cheque'
    method: text("method").notNull(),
    reference: text("reference"),
    paidOn: date("paid_on").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique("supplier_payments_tenant_id_id_key").on(t.tenantId, t.id),
    index("supplier_payments_supplier_idx").on(t.tenantId, t.supplierId, t.paidOn),
    foreignKey({ name: "supplier_payments_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }).onDelete("restrict"),
    foreignKey({ name: "supplier_payments_purchase_fk", columns: [t.tenantId, t.purchaseId], foreignColumns: [purchases.tenantId, purchases.id] }).onDelete("restrict"),
    check("supplier_payments_amount", sql`${t.amountPaise} > 0 AND ${t.amountPaise} <= 100000000000`),
    check("supplier_payments_method", sql`${t.method} in ('cash', 'upi', 'bank', 'cheque')`),
    check("supplier_payments_reference_length", sql`char_length(${t.reference}) <= 100`),
  ],
);

// Goods sent back to a supplier against one purchase (business rules 16):
// never more than bought minus earlier returns; amounts reverse the
// purchase's own lines (src/lib/return-maths); what we owe goes down.
// Never changed once saved: both tables are append-only.
export const purchaseReturns = pgTable(
  "purchase_returns",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    purchaseId: uuid("purchase_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    returnDate: date("return_date").notNull(),
    // The supplier's debit/credit note number, if they gave one.
    reference: text("reference"),
    reason: text("reason").notNull(),
    subtotalPaise: bigint("subtotal_paise", { mode: "number" }).notNull(),
    taxPaise: bigint("tax_paise", { mode: "number" }).notNull(),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique("purchase_returns_tenant_id_id_key").on(t.tenantId, t.id),
    index("purchase_returns_purchase_idx").on(t.tenantId, t.purchaseId),
    foreignKey({ name: "purchase_returns_purchase_fk", columns: [t.tenantId, t.purchaseId], foreignColumns: [purchases.tenantId, purchases.id] }).onDelete("restrict"),
    foreignKey({ name: "purchase_returns_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }).onDelete("restrict"),
    foreignKey({ name: "purchase_returns_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }).onDelete("restrict"),
    check("purchase_returns_totals", sql`${t.subtotalPaise} >= 0 AND ${t.taxPaise} >= 0 AND ${t.totalPaise} = ${t.subtotalPaise} + ${t.taxPaise}`),
    check("purchase_returns_text_lengths", sql`char_length(${t.reason}) between 3 and 500 AND char_length(${t.reference}) <= 40`),
  ],
);

export const purchaseReturnItems = pgTable(
  "purchase_return_items",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    purchaseReturnId: uuid("purchase_return_id").notNull(),
    lineNumber: smallint("line_number").notNull(),
    purchaseItemId: uuid("purchase_item_id").notNull(),
    variantId: uuid("variant_id").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
    subtotalPaise: bigint("subtotal_paise", { mode: "number" }).notNull(),
    taxPaise: bigint("tax_paise", { mode: "number" }).notNull(),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique("purchase_return_items_tenant_id_id_key").on(t.tenantId, t.id),
    unique("purchase_return_items_line_key").on(t.tenantId, t.purchaseReturnId, t.lineNumber),
    index("purchase_return_items_item_idx").on(t.tenantId, t.purchaseItemId),
    foreignKey({ name: "purchase_return_items_return_fk", columns: [t.tenantId, t.purchaseReturnId], foreignColumns: [purchaseReturns.tenantId, purchaseReturns.id] }).onDelete("restrict"),
    foreignKey({ name: "purchase_return_items_item_fk", columns: [t.tenantId, t.purchaseItemId], foreignColumns: [purchaseItems.tenantId, purchaseItems.id] }).onDelete("restrict"),
    foreignKey({ name: "purchase_return_items_variant_fk", columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }).onDelete("restrict"),
    check("purchase_return_items_line_number", sql`${t.lineNumber} between 1 and 200`),
    check("purchase_return_items_quantity", sql`${t.quantity} > 0`),
    check("purchase_return_items_totals", sql`${t.subtotalPaise} >= 0 AND ${t.taxPaise} >= 0 AND ${t.totalPaise} = ${t.subtotalPaise} + ${t.taxPaise}`),
  ],
);
