import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, numeric, pgTable, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, mutableRowColumns, tenantIdColumn } from "@/db/columns";
import { productVariants, serialNumbers } from "@/modules/catalog/schema";
import { customers } from "@/modules/parties/schema";
import { branches, tenants } from "@/modules/tenants/schema";

// Bill and credit-note counters (business rules 5.3 and 12). One row per
// business, series, prefix and financial year. The next number is taken
// inside the sale's own transaction with a row lock, so a sale that fails
// gives its number back: no gaps.

export const invoiceSequences = pgTable(
  "invoice_sequences",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    // 'invoice' | 'credit_note'
    series: text("series").notNull(),
    prefix: text("prefix").notNull(),
    financialYear: text("financial_year").notNull(), // "26-27"
    lastNumber: integer("last_number").notNull(),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("invoice_sequences_tenant_id_id_key").on(t.tenantId, t.id),
    unique("invoice_sequences_key").on(t.tenantId, t.series, t.prefix, t.financialYear),
    check("invoice_sequences_series", sql`${t.series} in ('invoice', 'credit_note')`),
    check("invoice_sequences_prefix", sql`${t.prefix} ~ '^[A-Z0-9]{1,4}$'`),
    check("invoice_sequences_year", sql`${t.financialYear} ~ '^([0-9]{2}-[0-9]{2}|[0-9]{4})$'`),
    check("invoice_sequences_range", sql`${t.lastNumber} between 1 and 99999`),
  ],
);

// Sales bills (blueprint 7.5; business rules 3-6, 15). A posted bill is never
// edited: the only change allowed is voiding it, the same day (database
// trigger). Lines and payments are append-only. Everything a printed bill
// needs is copied onto it at the moment of sale (rule 4.7), so later
// changes to products, rates, customers or settings never change old bills.
export const invoices = pgTable(
  "invoices",
  {
    // Made on the device (blueprint 8.1), so a retried sale keeps its id.
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").notNull(),
    number: text("number").notNull(), // INV/26-27/00001
    prefix: text("prefix").notNull(),
    financialYear: text("financial_year").notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    invoiceDate: date("invoice_date").notNull(), // in the business's time zone
    // 'posted' | 'voided'
    status: text("status").notNull().default("posted"),
    // Seller, as at the sale.
    sellerName: text("seller_name").notNull(),
    sellerGstin: text("seller_gstin"),
    sellerStateCode: text("seller_state_code").notNull(),
    gstRegistration: text("gst_registration").notNull(),
    pricesIncludeTax: boolean("prices_include_tax").notNull(),
    chargesGst: boolean("charges_gst").notNull(),
    // Buyer, as at the sale (none for a walk-in customer).
    customerId: uuid("customer_id"),
    buyerName: text("buyer_name"),
    buyerPhone: text("buyer_phone"),
    buyerAddress: text("buyer_address"),
    buyerGstin: text("buyer_gstin"),
    placeOfSupply: text("place_of_supply").notNull(), // state code
    interState: boolean("inter_state").notNull(),
    // Money, integer paise.
    grossPaise: bigint("gross_paise", { mode: "number" }).notNull(),
    discountPaise: bigint("discount_paise", { mode: "number" }).notNull(),
    taxablePaise: bigint("taxable_paise", { mode: "number" }).notNull(),
    cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull(),
    sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull(),
    igstPaise: bigint("igst_paise", { mode: "number" }).notNull(),
    taxPaise: bigint("tax_paise", { mode: "number" }).notNull(),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    roundOffPaise: bigint("round_off_paise", { mode: "number" }).notNull(),
    payablePaise: bigint("payable_paise", { mode: "number" }).notNull(),
    paidPaise: bigint("paid_paise", { mode: "number" }).notNull(),
    creditPaise: bigint("credit_paise", { mode: "number" }).notNull(),
    voidReason: text("void_reason"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique("invoices_tenant_id_id_key").on(t.tenantId, t.id),
    unique("invoices_number_key").on(t.tenantId, t.number),
    unique("invoices_sequence_key").on(t.tenantId, t.prefix, t.financialYear, t.sequenceNumber),
    index("invoices_tenant_date_idx").on(t.tenantId, t.invoiceDate),
    index("invoices_customer_idx").on(t.tenantId, t.customerId),
    foreignKey({ name: "invoices_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }).onDelete("restrict"),
    foreignKey({ name: "invoices_customer_fk", columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }).onDelete("restrict"),
    check("invoices_status_valid", sql`${t.status} in ('posted', 'voided')`),
    check("invoices_registration", sql`${t.gstRegistration} in ('registered', 'composition', 'unregistered')`),
    check("invoices_charges_gst", sql`${t.chargesGst} = (${t.gstRegistration} = 'registered')`),
    check("invoices_number_format", sql`char_length(${t.number}) <= 16 AND ${t.sequenceNumber} between 1 and 99999`),
    check("invoices_state_codes", sql`${t.sellerStateCode} ~ '^[0-9]{2}$' AND ${t.placeOfSupply} ~ '^[0-9]{2}$'`),
    check("invoices_inter_state", sql`${t.interState} = (${t.placeOfSupply} <> ${t.sellerStateCode})`),
    check("invoices_money_non_negative", sql`${t.grossPaise} >= 0 AND ${t.discountPaise} >= 0 AND ${t.taxablePaise} >= 0 AND ${t.cgstPaise} >= 0 AND ${t.igstPaise} >= 0 AND ${t.paidPaise} >= 0 AND ${t.creditPaise} >= 0`),
    check("invoices_totals", sql`${t.taxablePaise} + ${t.taxPaise} = ${t.totalPaise} AND ${t.cgstPaise} = ${t.sgstPaise} AND ${t.cgstPaise} + ${t.sgstPaise} + ${t.igstPaise} = ${t.taxPaise} AND ${t.discountPaise} <= ${t.grossPaise}`),
    check("invoices_no_gst_when_not_charged", sql`${t.chargesGst} OR ${t.taxPaise} = 0`),
    check("invoices_split_by_place", sql`(${t.interState} AND ${t.cgstPaise} = 0) OR (NOT ${t.interState} AND ${t.igstPaise} = 0)`),
    check("invoices_round_off", sql`${t.roundOffPaise} between -49 and 50 AND ${t.payablePaise} = ${t.totalPaise} + ${t.roundOffPaise}`),
    check("invoices_paid_and_credit", sql`${t.paidPaise} + ${t.creditPaise} = ${t.payablePaise}`),
    check("invoices_credit_needs_customer", sql`${t.creditPaise} = 0 OR ${t.customerId} IS NOT NULL`),
    check("invoices_void_fields", sql`(${t.status} = 'voided') = (${t.voidReason} IS NOT NULL AND ${t.voidedAt} IS NOT NULL AND ${t.voidedBy} IS NOT NULL)`),
    check("invoices_text_lengths", sql`char_length(${t.sellerName}) <= 200 AND char_length(${t.buyerName}) <= 200 AND char_length(${t.buyerAddress}) <= 500 AND char_length(${t.voidReason}) <= 500`),
  ],
);

export const invoiceItems = pgTable(
  "invoice_items",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id").notNull(),
    lineNumber: smallint("line_number").notNull(),
    variantId: uuid("variant_id").notNull(),
    // Snapshot of the item at the sale.
    productName: text("product_name").notNull(),
    variantLabel: text("variant_label").notNull(),
    sku: text("sku").notNull(),
    hsnCode: text("hsn_code"),
    unitCode: text("unit_code").notNull(),
    serialNumberId: uuid("serial_number_id"),
    quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
    unitPricePaise: bigint("unit_price_paise", { mode: "number" }).notNull(),
    taxCategory: text("tax_category").notNull(),
    taxLabel: text("tax_label").notNull(),
    taxRate: numeric("tax_rate", { precision: 7, scale: 4 }).notNull(),
    grossPaise: bigint("gross_paise", { mode: "number" }).notNull(),
    lineDiscountPaise: bigint("line_discount_paise", { mode: "number" }).notNull(),
    billDiscountPaise: bigint("bill_discount_paise", { mode: "number" }).notNull(),
    taxablePaise: bigint("taxable_paise", { mode: "number" }).notNull(),
    cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull(),
    sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull(),
    igstPaise: bigint("igst_paise", { mode: "number" }).notNull(),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    // Average cost per unit at the sale (rule 7.3), for profit reports.
    unitCostPaise: numeric("unit_cost_paise", { precision: 18, scale: 4 }).notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique("invoice_items_tenant_id_id_key").on(t.tenantId, t.id),
    unique("invoice_items_line_key").on(t.tenantId, t.invoiceId, t.lineNumber),
    foreignKey({ name: "invoice_items_invoice_fk", columns: [t.tenantId, t.invoiceId], foreignColumns: [invoices.tenantId, invoices.id] }).onDelete("restrict"),
    foreignKey({ name: "invoice_items_variant_fk", columns: [t.tenantId, t.variantId], foreignColumns: [productVariants.tenantId, productVariants.id] }).onDelete("restrict"),
    foreignKey({ name: "invoice_items_serial_fk", columns: [t.tenantId, t.serialNumberId], foreignColumns: [serialNumbers.tenantId, serialNumbers.id] }).onDelete("restrict"),
    check("invoice_items_line_number", sql`${t.lineNumber} between 1 and 500`),
    check("invoice_items_quantity", sql`${t.quantity} > 0 AND (${t.serialNumberId} IS NULL OR ${t.quantity} = 1)`),
    check("invoice_items_rate", sql`${t.taxRate} >= 0 AND ${t.taxRate} <= 100`),
    check("invoice_items_money", sql`${t.unitPricePaise} >= 0 AND ${t.lineDiscountPaise} >= 0 AND ${t.billDiscountPaise} >= 0 AND ${t.taxablePaise} >= 0 AND ${t.cgstPaise} = ${t.sgstPaise} AND ${t.igstPaise} >= 0 AND ${t.cgstPaise} >= 0`),
    check("invoice_items_totals", sql`${t.taxablePaise} + ${t.cgstPaise} + ${t.sgstPaise} + ${t.igstPaise} = ${t.totalPaise} AND ${t.lineDiscountPaise} + ${t.billDiscountPaise} <= ${t.grossPaise}`),
    check("invoice_items_cost", sql`${t.unitCostPaise} >= 0`),
  ],
);

// Money received for a bill. Positive = received; a void adds the matching
// negative rows (refund), never changing the originals. Append-only.
export const invoicePayments = pgTable(
  "invoice_payments",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id").notNull(),
    // 'cash' | 'card' | 'upi'
    method: text("method").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    reference: text("reference"),
    // 'sale' | 'void'
    kind: text("kind").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique("invoice_payments_tenant_id_id_key").on(t.tenantId, t.id),
    index("invoice_payments_invoice_idx").on(t.tenantId, t.invoiceId),
    foreignKey({ name: "invoice_payments_invoice_fk", columns: [t.tenantId, t.invoiceId], foreignColumns: [invoices.tenantId, invoices.id] }).onDelete("restrict"),
    check("invoice_payments_method", sql`${t.method} in ('cash', 'card', 'upi')`),
    check("invoice_payments_kind", sql`(${t.kind} = 'sale' AND ${t.amountPaise} > 0) OR (${t.kind} = 'void' AND ${t.amountPaise} < 0)`),
    check("invoice_payments_amount", sql`abs(${t.amountPaise}) <= 100000000000`),
    check("invoice_payments_reference_length", sql`char_length(${t.reference}) <= 100`),
  ],
);
