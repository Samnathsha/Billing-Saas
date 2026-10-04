import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, tenantIdColumn } from "@/db/columns";
import { creditNotes, invoices } from "@/modules/sales/schema";
import { devices, tenants } from "@/modules/tenants/schema";

// Every write a device sends carries a client_op_id (business rule 9.2). The
// result is stored here, so a retried operation returns the same result
// instead of running twice. Append-only.
export const syncOperations = pgTable(
  "sync_operations",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    deviceId: uuid("device_id").notNull(),
    clientOpId: uuid("client_op_id").notNull(),
    operation: text("operation").notNull(),
    // applied: done. rejected: refused, nothing changed. flagged: accepted
    // but needs a manager (e.g. offline sale into negative stock, rule 7.2).
    status: text("status").notNull(),
    result: jsonb("result"),
    receivedAt: createdAtColumn(),
  },
  (t) => [
    unique("sync_operations_client_op_key").on(t.tenantId, t.deviceId, t.clientOpId),
    foreignKey({
      name: "sync_operations_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [devices.tenantId, devices.id],
    }).onDelete("restrict"),
    check("sync_operations_operation_format", sql`${t.operation} ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
    check("sync_operations_status_valid", sql`${t.status} in ('applied', 'rejected', 'flagged')`),
  ],
);

// Idempotency for writes from screens (purchases, later sales): the screen
// sends a fresh key per attempt; a retry with the same key gets the stored
// result instead of running twice (CLAUDE.md: every money or stock write
// has an idempotency key). Append-only.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    key: uuid("key").notNull(),
    operation: text("operation").notNull(),
    result: jsonb("result").notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique("idempotency_keys_key").on(t.tenantId, t.key),
    check("idempotency_keys_operation_format", sql`${t.operation} ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
  ],
);

// What an offline bill or return no longer fitted when it reached the server
// (business rules 17: the sale is kept and flagged for a manager). The only
// change ever made is open -> resolved, with who, when and a note
// (database trigger). The list is repeated in the check below (a unit test
// keeps the two the same).
export const SYNC_FLAG_CODES = [
  "stock_short",
  "price_changed",
  "tax_changed",
  "settings_changed",
  "discount_over_limit",
  "item_archived",
  "imei_unavailable",
  "role_removed",
  "date_corrected",
  "number_gap",
  "return_after_window",
  "refund_differs",
] as const;

export const syncFlags = pgTable(
  "sync_flags",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    deviceId: uuid("device_id").notNull(),
    invoiceId: uuid("invoice_id"),
    creditNoteId: uuid("credit_note_id"),
    code: text("code").notNull(),
    // What was found, e.g. { "item": "Cotton Shirt", "paid": 79900, "now": 84900 }.
    detail: jsonb("detail").notNull(),
    status: text("status").notNull().default("open"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by"),
    resolutionNote: text("resolution_note"),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique("sync_flags_tenant_id_id_key").on(t.tenantId, t.id),
    index("sync_flags_open_idx").on(t.tenantId, t.status, t.createdAt),
    foreignKey({ name: "sync_flags_device_fk", columns: [t.tenantId, t.deviceId], foreignColumns: [devices.tenantId, devices.id] }).onDelete("restrict"),
    foreignKey({ name: "sync_flags_invoice_fk", columns: [t.tenantId, t.invoiceId], foreignColumns: [invoices.tenantId, invoices.id] }).onDelete("restrict"),
    foreignKey({ name: "sync_flags_credit_note_fk", columns: [t.tenantId, t.creditNoteId], foreignColumns: [creditNotes.tenantId, creditNotes.id] }).onDelete("restrict"),
    check("sync_flags_one_document", sql`(${t.invoiceId} IS NULL) <> (${t.creditNoteId} IS NULL)`),
    check(
      "sync_flags_code_valid",
      sql`${t.code} in ('stock_short', 'price_changed', 'tax_changed', 'settings_changed', 'discount_over_limit', 'item_archived', 'imei_unavailable', 'role_removed', 'date_corrected', 'number_gap', 'return_after_window', 'refund_differs')`,
    ),
    check("sync_flags_status_valid", sql`${t.status} in ('open', 'resolved')`),
    check("sync_flags_resolved_fields", sql`(${t.status} = 'resolved') = (${t.resolvedAt} IS NOT NULL AND ${t.resolvedBy} IS NOT NULL AND ${t.resolutionNote} IS NOT NULL)`),
    check("sync_flags_note_length", sql`char_length(${t.resolutionNote}) between 3 and 500`),
  ],
);
