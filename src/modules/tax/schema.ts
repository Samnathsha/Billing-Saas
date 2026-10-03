import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, numeric, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { mutableRowColumns } from "@/db/columns";

// GST as data, never constants in code (business rule 4). Global: the law
// is the same for every business. Read-only for the app; rows come only
// from reviewed migrations. Until the accountant supplies real rates, only
// clearly labelled TEST rows exist (rule 4.3, open questions 1 and 2).

// What a product points to, e.g. "test_5". A category can have several
// rates over time and, for clothing, by price per piece.
export const taxCategories = pgTable(
  "tax_categories",
  {
    code: text("code").primaryKey(),
    label: text("label").notNull(),
    isTest: boolean("is_test").notNull().default(false),
    ...mutableRowColumns(),
  },
  (t) => [
    check("tax_categories_code_format", sql`${t.code} ~ '^[a-z0-9_]{1,40}$'`),
    check("tax_categories_label_length", sql`char_length(${t.label}) between 1 and 100`),
  ],
);

export const taxRates = pgTable(
  "tax_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    countryCode: text("country_code").notNull().default("IN"),
    taxCategory: text("tax_category")
      .notNull()
      .references(() => taxCategories.code, { onDelete: "restrict" }),
    label: text("label").notNull(),
    // Percent, e.g. 5.0000. numeric(7,4), never floating point (rule 1.3).
    rate: numeric("rate", { precision: 7, scale: 4 }).notNull(),
    // Optional price range per piece (inclusive min, exclusive max), for
    // clothing slabs. Empty = any price.
    priceMinPaise: bigint("price_min_paise", { mode: "number" }),
    priceMaxPaise: bigint("price_max_paise", { mode: "number" }),
    effectiveFrom: date("effective_from").notNull(),
    // Exclusive; empty = still valid.
    effectiveTo: date("effective_to"),
    isTest: boolean("is_test").notNull().default(false),
    ...mutableRowColumns(),
  },
  (t) => [
    check("tax_rates_country_format", sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
    check("tax_rates_rate_range", sql`${t.rate} >= 0 AND ${t.rate} <= 100`),
    check("tax_rates_label_length", sql`char_length(${t.label}) between 1 and 100`),
    check(
      "tax_rates_price_range",
      sql`(${t.priceMinPaise} IS NULL OR ${t.priceMinPaise} >= 0) AND (${t.priceMaxPaise} IS NULL OR ${t.priceMaxPaise} > coalesce(${t.priceMinPaise}, 0))`,
    ),
    check("tax_rates_dates", sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`),
    // A test rate is always visibly labelled "TEST ..." (and only test
    // rates are), so it can never be mistaken for a real one on a bill.
    check("tax_rates_test_label", sql`${t.isTest} = (${t.label} LIKE 'TEST %')`),
  ],
);
