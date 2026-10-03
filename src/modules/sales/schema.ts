import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, unique } from "drizzle-orm/pg-core";
import { idColumn, mutableRowColumns, tenantIdColumn } from "@/db/columns";
import { tenants } from "@/modules/tenants/schema";

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
