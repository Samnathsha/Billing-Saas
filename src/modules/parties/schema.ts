import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, mutableRowColumns, tenantIdColumn } from "@/db/columns";
import { tenants } from "@/modules/tenants/schema";

// Suppliers (Phase 6; customers come in Phase 7) and the party ledger:
// balances are never a stored number someone can edit, they are the sum of
// these append-only rows (blueprint 6.2).

export const suppliers = pgTable(
  "suppliers",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    phone: text("phone"),
    gstin: text("gstin"),
    stateCode: text("state_code"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("suppliers_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("suppliers_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
    check("suppliers_name_length", sql`char_length(${t.name}) between 1 and 200`),
    check("suppliers_phone_format", sql`${t.phone} ~ '^[+0-9 -]{6,20}$'`),
    check("suppliers_gstin_format", sql`${t.gstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'`),
    check("suppliers_state_code_format", sql`${t.stateCode} ~ '^[0-9]{2}$'`),
    check("suppliers_gstin_matches_state", sql`${t.gstin} IS NULL OR (${t.stateCode} IS NOT NULL AND left(${t.gstin}, 2) = ${t.stateCode})`),
  ],
);

// Positive amount = we owe the supplier more (a purchase); negative = less
// (a payment, a void). Customer rows arrive in Phase 7.
export const partyLedgerEntries = pgTable(
  "party_ledger_entries",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    supplierId: uuid("supplier_id"),
    entryType: text("entry_type").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    note: text("note"),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique("party_ledger_entries_tenant_id_id_key").on(t.tenantId, t.id),
    // One entry per source and type: a retry cannot book twice.
    unique("party_ledger_entries_source_key").on(t.tenantId, t.sourceType, t.sourceId, t.entryType),
    index("party_ledger_entries_supplier_idx").on(t.tenantId, t.supplierId, t.createdAt),
    foreignKey({ name: "party_ledger_entries_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }).onDelete("restrict"),
    check("party_ledger_entries_party", sql`${t.supplierId} IS NOT NULL`),
    check(
      "party_ledger_entries_type_valid",
      sql`${t.entryType} in ('opening', 'invoice', 'payment', 'return', 'purchase', 'purchase_return', 'adjustment', 'void_reversal')`,
    ),
    check("party_ledger_entries_amount_not_zero", sql`${t.amountPaise} <> 0`),
    check("party_ledger_entries_note_length", sql`char_length(${t.note}) <= 500`),
  ],
);
