import { sql } from "drizzle-orm";
import { check, foreignKey, index, inet, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, tenantIdColumn } from "@/db/columns";
import { users } from "@/modules/auth/schema";
import { devices, tenants } from "@/modules/tenants/schema";

// Who did what, to which record, and when (blueprint 5.5). Append-only: no
// updated_at or version, and Phase 2 step 5 blocks UPDATE and DELETE.
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    occurredAt: createdAtColumn(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    // Role name at the time, kept as text so later role changes do not
    // rewrite history.
    actorRole: text("actor_role"),
    deviceId: uuid("device_id"),
    // e.g. "invoice.void", "settings.update", "auth.login_failed".
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: inet("ip"),
    requestId: text("request_id"),
  },
  (t) => [
    foreignKey({
      name: "audit_logs_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [devices.tenantId, devices.id],
    }).onDelete("restrict"),
    index("audit_logs_tenant_time_idx").on(t.tenantId, t.occurredAt.desc()),
    index("audit_logs_tenant_entity_idx").on(t.tenantId, t.entityType, t.entityId),
    check("audit_logs_action_format", sql`${t.action} ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
    check("audit_logs_request_id_length", sql`char_length(${t.requestId}) <= 100`),
  ],
);
