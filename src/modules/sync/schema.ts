import { sql } from "drizzle-orm";
import { check, foreignKey, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, tenantIdColumn } from "@/db/columns";
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
