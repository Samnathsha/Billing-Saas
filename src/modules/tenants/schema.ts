import { sql } from "drizzle-orm";
import {
  bigint,
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
    // Business profile (printed on invoices). Empty until the owner fills it.
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    // GST state code, e.g. '33' (Tamil Nadu). Decides CGST+SGST vs IGST.
    stateCode: text("state_code"),
    pincode: text("pincode"),
    phone: text("phone"),
    contactEmail: text("contact_email"),
    // 'registered' | 'composition' | 'unregistered'; null = not set yet
    // (sales will require it). Owner or accountant to validate. Rule 4.5.
    gstRegistration: text("gst_registration"),
    gstin: text("gstin"),
    // Bill and credit-note prefixes: PREFIX/YY-YY/NNNNN (business rules
    // section 12). Locked after the year's first bill (enforced in Phase 7).
    invoicePrefix: text("invoice_prefix").notNull().default("INV"),
    creditNotePrefix: text("credit_note_prefix").notNull().default("CN"),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("settings_tenant_key").on(t.tenantId),
    check("settings_address_lengths", sql`char_length(${t.addressLine1}) <= 200 AND char_length(${t.addressLine2}) <= 200 AND char_length(${t.city}) <= 100`),
    check("settings_state_code_format", sql`${t.stateCode} ~ '^[0-9]{2}$'`),
    check("settings_pincode_format", sql`${t.pincode} ~ '^[1-9][0-9]{5}$'`),
    check("settings_phone_format", sql`${t.phone} ~ '^[+0-9 -]{6,20}$'`),
    check("settings_contact_email_length", sql`char_length(${t.contactEmail}) <= 254`),
    check("settings_gst_registration_valid", sql`${t.gstRegistration} in ('registered', 'composition', 'unregistered')`),
    check("settings_gstin_format", sql`${t.gstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'`),
    // A GSTIN exactly when registered or composition, and its first two
    // digits are the business's state.
    check(
      "settings_gstin_matches_registration",
      sql`(${t.gstin} IS NOT NULL) = (${t.gstRegistration} IS NOT NULL AND ${t.gstRegistration} <> 'unregistered')`,
    ),
    check("settings_invoice_prefix_format", sql`${t.invoicePrefix} ~ '^[A-Z0-9]{1,4}$'`),
    check("settings_credit_note_prefix_format", sql`${t.creditNotePrefix} ~ '^[A-Z0-9]{1,4}$'`),
    // Two series with the same prefix would produce clashing numbers.
    check("settings_prefixes_differ", sql`${t.invoicePrefix} <> ${t.creditNotePrefix}`),
    check("settings_gstin_matches_state", sql`${t.gstin} IS NULL OR (${t.stateCode} IS NOT NULL AND left(${t.gstin}, 2) = ${t.stateCode})`),
    check("settings_country_code_format", sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
    check("settings_currency_code_format", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("settings_time_zone_length", sql`char_length(${t.timeZone}) between 1 and 64`),
    check("settings_fy_start_month_range", sql`${t.financialYearStartMonth} between 1 and 12`),
    check("settings_cashier_discount_range", sql`${t.cashierDiscountLimitBps} between 0 and 10000`),
  ],
);

// ---------------------------------------------------------------------------
// Plans and subscriptions (blueprint Phase 4; owner decision 2026-10-02,
// business rules section 11). No payments yet.
// ---------------------------------------------------------------------------

// What a plan allows. Platform table (no tenant): the app may only read it.
export const plans = pgTable(
  "plans",
  {
    code: text("code").primaryKey(),
    name: text("name").notNull(),
    // Integer paise, never floating point (rule 1.2). 0 during the pilot.
    priceMonthlyPaise: bigint("price_monthly_paise", { mode: "number" }).notNull().default(0),
    maxBranches: integer("max_branches").notNull(),
    // Active members of the business, owner included.
    maxUsers: integer("max_users").notNull(),
    maxDevices: integer("max_devices").notNull(),
    // The plan a business is on when it has no subscription row.
    isDefault: boolean("is_default").notNull().default(false),
    ...mutableRowColumns(),
  },
  (t) => [
    check("plans_code_format", sql`${t.code} ~ '^[a-z0-9_]{1,30}$'`),
    check("plans_name_length", sql`char_length(${t.name}) between 1 and 100`),
    check("plans_price_not_negative", sql`${t.priceMonthlyPaise} >= 0`),
    check("plans_limits_positive", sql`${t.maxBranches} >= 1 AND ${t.maxUsers} >= 1 AND ${t.maxDevices} >= 0`),
    uniqueIndex("plans_one_default").on(t.isDefault).where(sql`${t.isDefault}`),
  ],
);

// Which plan a business is on. One row per business; the app may create it
// with the business, changes come from the platform (not from shop staff).
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    planCode: text("plan_code")
      .notNull()
      .references(() => plans.code, { onDelete: "restrict" }),
    status: text("status").notNull().default("active"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("subscriptions_tenant_key").on(t.tenantId),
    check("subscriptions_status_valid", sql`${t.status} in ('trialing', 'active', 'past_due', 'cancelled')`),
  ],
);
