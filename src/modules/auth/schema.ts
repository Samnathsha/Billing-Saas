import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, mutableRowColumns, tenantIdColumn } from "@/db/columns";
import { branches, tenants } from "@/modules/tenants/schema";

// A person who can log in. Platform table: one identity may belong to
// several businesses through memberships. Password and session storage are
// decided with the auth library in Phase 3.
export const users = pgTable(
  "users",
  {
    id: idColumn(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    ...mutableRowColumns(),
  },
  (t) => [
    // One account per email address, ignoring upper/lower case.
    uniqueIndex("users_email_key").on(sql`lower(${t.email})`),
    check("users_email_format", sql`char_length(${t.email}) between 3 and 254 and ${t.email} like '%_@_%'`),
    check("users_display_name_length", sql`char_length(${t.displayName}) between 1 and 100`),
    check("users_status_valid", sql`${t.status} in ('active', 'disabled')`),
  ],
);

// The fixed list of things a role can be allowed to do (blueprint 5.3).
// Global, read-only for the app; rows are added by migrations only.
export const permissions = pgTable(
  "permissions",
  {
    code: text("code").primaryKey(),
    description: text("description").notNull(),
  },
  (t) => [check("permissions_code_format", sql`${t.code} ~ '^[a-z_]+(\\.[a-z_]+)+$'`)],
);

// A business's roles (Owner, Admin, Manager, Cashier, Accountant by default).
// Per tenant, so each business can adjust its roles later.
export const roles = pgTable(
  "roles",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    // Default roles cannot be renamed or deleted (enforced in the service).
    isSystem: boolean("is_system").notNull().default(false),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("roles_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("roles_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
    check("roles_name_length", sql`char_length(${t.name}) between 1 and 50`),
  ],
);

// Which permissions each role has.
export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    roleId: uuid("role_id").notNull(),
    permissionCode: text("permission_code")
      .notNull()
      .references(() => permissions.code, { onDelete: "restrict" }),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("role_permissions_role_permission_key").on(t.tenantId, t.roleId, t.permissionCode),
    foreignKey({
      name: "role_permissions_role_fk",
      columns: [t.tenantId, t.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }).onDelete("cascade"),
  ],
);

// Links a user to a business with one role, optionally limited to one branch
// (branch_id null = all branches). V1 screens use one business per user.
export const memberships = pgTable(
  "memberships",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    roleId: uuid("role_id").notNull(),
    branchId: uuid("branch_id"),
    status: text("status").notNull().default("active"),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("memberships_tenant_id_id_key").on(t.tenantId, t.id),
    unique("memberships_tenant_user_key").on(t.tenantId, t.userId),
    foreignKey({
      name: "memberships_role_fk",
      columns: [t.tenantId, t.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "memberships_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("restrict"),
    index("memberships_user_idx").on(t.userId),
    check("memberships_status_valid", sql`${t.status} in ('active', 'disabled')`),
  ],
);

// Counters for login and reset rate limits (blueprint 5.2). Platform table:
// limits apply before anyone is logged in. Phase 3 decides the key format
// (it should be a hash, not a raw email or IP address).
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    blockedUntil: timestamp("blocked_until", { withTimezone: true }),
    createdAt: createdAtColumn(),
  },
  (t) => [
    check("rate_limits_key_length", sql`char_length(${t.key}) between 1 and 200`),
    check("rate_limits_count_positive", sql`${t.count} >= 0`),
  ],
);
