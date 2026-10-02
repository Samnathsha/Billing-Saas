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
import { bigint, inet, jsonb } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, mutableRowColumns, tenantIdColumn } from "@/db/columns";
import { branches, tenants } from "@/modules/tenants/schema";

// A person who can log in. Platform table: one identity may belong to
// several businesses through memberships. Also Better Auth's "user" table
// (ADR 0003); `name` is mapped to display_name. Created only by Better Auth
// (auth_service); the password lives in `accounts`.
export const users = pgTable(
  "users",
  {
    id: idColumn(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
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

// An invitation to join a business with a role (Phase 4). The emailed link
// carries a random secret; only its SHA-256 hash is stored. Valid once, for
// 7 days, and only for the invited email address (checked on accept).
export const invitations = pgTable(
  "invitations",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    // Lower case; the accepting account must have exactly this email.
    email: text("email").notNull(),
    roleId: uuid("role_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // 'pending' | 'accepted' | 'revoked'. An expired pending one is shown as
    // expired and cannot be accepted.
    status: text("status").notNull().default("pending"),
    invitedBy: uuid("invited_by").notNull(),
    acceptedBy: uuid("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("invitations_tenant_id_id_key").on(t.tenantId, t.id),
    unique("invitations_tenant_token_key").on(t.tenantId, t.tokenHash),
    // One open invitation per address per business.
    uniqueIndex("invitations_tenant_email_pending_key").on(t.tenantId, t.email).where(sql`${t.status} = 'pending'`),
    foreignKey({
      name: "invitations_role_fk",
      columns: [t.tenantId, t.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }).onDelete("restrict"),
    check("invitations_email_lower", sql`${t.email} = lower(${t.email}) AND char_length(${t.email}) between 3 and 254 AND ${t.email} like '%_@_%'`),
    check("invitations_token_hash_format", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("invitations_status_valid", sql`${t.status} in ('pending', 'accepted', 'revoked')`),
    check("invitations_accepted_fields", sql`(${t.status} = 'accepted') = (${t.acceptedBy} IS NOT NULL AND ${t.acceptedAt} IS NOT NULL)`),
  ],
);

// ---------------------------------------------------------------------------
// Login tables (Better Auth, ADR 0002/0003). Only auth_service can reach
// them; app_user has no access at all. Column names follow Better Auth.
// ---------------------------------------------------------------------------

const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// A signed-in browser or till. Revoking = deleting the row; the cookie then
// stops working at once (cookie cache is off). active_tenant_id is the
// business chosen after login; it is re-checked against memberships on every
// request (ADR 0003), so it is not a tenant_id for row-level security.
export const sessions = pgTable(
  "sessions",
  {
    id: idColumn(),
    token: text("token").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    activeTenantId: uuid("active_tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [unique("sessions_token_key").on(t.token), index("sessions_user_idx").on(t.userId)],
);

// How a user logs in. For email/password: provider_id = 'credential' and
// `password` holds the Argon2id hash.
export const accounts = pgTable(
  "accounts",
  {
    id: idColumn(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps(),
  },
  (t) => [
    unique("accounts_provider_account_key").on(t.providerId, t.accountId),
    index("accounts_user_idx").on(t.userId),
  ],
);

// Single-use, expiring tokens (email verification, password reset).
// Identifiers are stored hashed (storeIdentifier: "hashed").
export const verifications = pgTable(
  "verifications",
  {
    id: idColumn(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

// Login and reset rate-limit counters (Better Auth's database storage).
export const rateLimits = pgTable(
  "rate_limits",
  {
    id: idColumn(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    // Milliseconds since 1970, as Better Auth stores it.
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (t) => [unique("rate_limits_key_key").on(t.key), check("rate_limits_count_positive", sql`${t.count} >= 0`)],
);

// Security events that happen before a business is known (failed logins,
// lockouts, password resets). Append-only. Review question R6.
export const securityEvents = pgTable(
  "security_events",
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    // e.g. "auth.login_failed", "auth.password_reset".
    event: text("event").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "restrict" }),
    // SHA-256 of the lower-cased email for unknown accounts: links repeated
    // attempts without storing the address itself.
    emailHash: text("email_hash"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    details: jsonb("details"),
  },
  (t) => [
    index("security_events_time_idx").on(t.createdAt.desc()),
    check("security_events_event_format", sql`${t.event} ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
  ],
);
