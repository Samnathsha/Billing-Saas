import { integer, timestamp, uuid } from "drizzle-orm/pg-core";

// Shared column definitions so every table follows blueprint section 6.1.

// Random UUID (v4). The app may supply one (offline devices create records
// before syncing); the database fills it in otherwise. Never sequential.
export const idColumn = () => uuid("id").primaryKey().defaultRandom();

// The owning business. Foreign keys and RLS policies are added per table.
export const tenantIdColumn = () => uuid("tenant_id").notNull();

export const createdAtColumn = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// Standard columns for tables whose rows can change (blueprint 6.1).
// Append-only tables (audit_logs, sync_operations) use createdAtColumn only.
export const mutableRowColumns = () => ({
  createdAt: createdAtColumn(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  // Null for rows the system creates (e.g. default roles for a new business).
  createdBy: uuid("created_by"),
  // Incremented on every change; used to detect sync conflicts (Phase 10).
  version: integer("version").notNull().default(1),
});
