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
import { idColumn, mutableRowColumns, tenantIdColumn } from "@/db/columns";

// A business using the app. Platform table: its own id is the tenant id, so
// its RLS policy (Phase 2 step 3) matches id instead of tenant_id.
export const tenants = pgTable(
  "tenants",
  {
    id: idColumn(),
    name: text("name").notNull(),
    // Business template (blueprint 6.4): switches fields and screens on.
    template: text("template").notNull(),
    status: text("status").notNull().default("active"),
    ...mutableRowColumns(),
  },
  (t) => [
    check("tenants_name_length", sql`char_length(${t.name}) between 1 and 200`),
    check("tenants_template_valid", sql`${t.template} in ('clothing', 'mobile')`),
    check("tenants_status_valid", sql`${t.status} in ('active', 'suspended', 'closed')`),
  ],
);

// A shop location. Stock is held per branch.
export const branches = pgTable(
  "branches",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...mutableRowColumns(),
  },
  (t) => [
    // Target for composite foreign keys: (tenant_id, branch_id) -> branches.
    unique("branches_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("branches_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
    check("branches_name_length", sql`char_length(${t.name}) between 1 and 100`),
  ],
);

// A till or phone that sells. Offline sync and invoice prefixes attach here.
export const devices = pgTable(
  "devices",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("devices_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "devices_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("restrict"),
    index("devices_tenant_branch_idx").on(t.tenantId, t.branchId),
    check("devices_name_length", sql`char_length(${t.name}) between 1 and 100`),
    check("devices_status_valid", sql`${t.status} in ('active', 'revoked')`),
  ],
);

// One row of business settings per tenant. Only rules already decided in
// docs/business-rules.md are here; GST registration fields come in Phase 4.
export const settings = pgTable(
  "settings",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    countryCode: text("country_code").notNull().default("IN"), // rule 1.1
    currencyCode: text("currency_code").notNull().default("INR"), // rule 1.1
    timeZone: text("time_zone").notNull().default("Asia/Kolkata"), // rule 1.5
    financialYearStartMonth: integer("financial_year_start_month").notNull().default(4), // rule 1.4: April
    pricesIncludeTax: boolean("prices_include_tax").notNull().default(true), // rule 3.1
    roundOffEnabled: boolean("round_off_enabled").notNull().default(true), // rule 3.5; open question 5
    // Basis points: 500 = 5.00%. Integer, never floating point. Rules 8.1, 8.3.
    cashierDiscountLimitBps: integer("cashier_discount_limit_bps").notNull().default(500),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("settings_tenant_key").on(t.tenantId),
    check("settings_country_code_format", sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
    check("settings_currency_code_format", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("settings_time_zone_length", sql`char_length(${t.timeZone}) between 1 and 64`),
    check("settings_fy_start_month_range", sql`${t.financialYearStartMonth} between 1 and 12`),
    check("settings_cashier_discount_range", sql`${t.cashierDiscountLimitBps} between 0 and 10000`),
  ],
);
