CREATE TABLE "tax_categories" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tax_categories_code_format" CHECK ("tax_categories"."code" ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "tax_categories_label_length" CHECK (char_length("tax_categories"."label") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" text DEFAULT 'IN' NOT NULL,
	"tax_category" text NOT NULL,
	"label" text NOT NULL,
	"rate" numeric(7, 4) NOT NULL,
	"price_min_paise" bigint,
	"price_max_paise" bigint,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tax_rates_country_format" CHECK ("tax_rates"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "tax_rates_rate_range" CHECK ("tax_rates"."rate" >= 0 AND "tax_rates"."rate" <= 100),
	CONSTRAINT "tax_rates_label_length" CHECK (char_length("tax_rates"."label") between 1 and 100),
	CONSTRAINT "tax_rates_price_range" CHECK (("tax_rates"."price_min_paise" IS NULL OR "tax_rates"."price_min_paise" >= 0) AND ("tax_rates"."price_max_paise" IS NULL OR "tax_rates"."price_max_paise" > coalesce("tax_rates"."price_min_paise", 0))),
	CONSTRAINT "tax_rates_dates" CHECK ("tax_rates"."effective_to" IS NULL OR "tax_rates"."effective_to" > "tax_rates"."effective_from"),
	CONSTRAINT "tax_rates_test_label" CHECK ("tax_rates"."is_test" = ("tax_rates"."label" LIKE 'TEST %'))
);
--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_tax_category_tax_categories_code_fk" FOREIGN KEY ("tax_category") REFERENCES "public"."tax_categories"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Hand-written part.

-- 1. Development rates only (business rule 4.3): clearly labelled TEST.
--    Real categories, slabs and dates come from the accountant (open
--    questions 1 and 2) in a later reviewed migration.
INSERT INTO tax_categories (code, label, is_test) VALUES
  ('test_5', 'TEST 5%', true),
  ('test_18', 'TEST 18%', true);
--> statement-breakpoint
INSERT INTO tax_rates (country_code, tax_category, label, rate, effective_from, is_test) VALUES
  ('IN', 'test_5', 'TEST 5%', 5.0000, '2017-07-01', true),
  ('IN', 'test_18', 'TEST 18%', 18.0000, '2017-07-01', true);
--> statement-breakpoint

-- 2. Global and read-only for the app (like plans and permissions).
ALTER TABLE tax_categories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tax_categories FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tax_category_read ON tax_categories AS PERMISSIVE FOR SELECT TO app_user USING (true);
--> statement-breakpoint
ALTER TABLE tax_rates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tax_rates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tax_rate_read ON tax_rates AS PERMISSIVE FOR SELECT TO app_user USING (true);
--> statement-breakpoint
GRANT SELECT ON tax_categories, tax_rates TO app_user;
