CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"gstin" text,
	"state_code" text,
	"credit_limit_paise" bigint DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "customers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "customers_name_length" CHECK (char_length("customers"."name") between 1 and 200),
	CONSTRAINT "customers_phone_format" CHECK ("customers"."phone" ~ '^[+0-9 -]{6,20}$'),
	CONSTRAINT "customers_gstin_format" CHECK ("customers"."gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
	CONSTRAINT "customers_state_code_format" CHECK ("customers"."state_code" ~ '^[0-9]{2}$'),
	CONSTRAINT "customers_gstin_matches_state" CHECK ("customers"."gstin" IS NULL OR ("customers"."state_code" IS NOT NULL AND left("customers"."gstin", 2) = "customers"."state_code")),
	CONSTRAINT "customers_credit_limit" CHECK ("customers"."credit_limit_paise" between 0 and 100000000000)
);
--> statement-breakpoint
CREATE TABLE "invoice_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"series" text NOT NULL,
	"prefix" text NOT NULL,
	"financial_year" text NOT NULL,
	"last_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "invoice_sequences_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoice_sequences_key" UNIQUE("tenant_id","series","prefix","financial_year"),
	CONSTRAINT "invoice_sequences_series" CHECK ("invoice_sequences"."series" in ('invoice', 'credit_note')),
	CONSTRAINT "invoice_sequences_prefix" CHECK ("invoice_sequences"."prefix" ~ '^[A-Z0-9]{1,4}$'),
	CONSTRAINT "invoice_sequences_year" CHECK ("invoice_sequences"."financial_year" ~ '^([0-9]{2}-[0-9]{2}|[0-9]{4})$'),
	CONSTRAINT "invoice_sequences_range" CHECK ("invoice_sequences"."last_number" between 1 and 99999)
);
--> statement-breakpoint
ALTER TABLE "party_ledger_entries" DROP CONSTRAINT "party_ledger_entries_party";--> statement-breakpoint
ALTER TABLE "party_ledger_entries" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_phone_key" ON "customers" USING btree ("tenant_id","phone");--> statement-breakpoint
ALTER TABLE "party_ledger_entries" ADD CONSTRAINT "party_ledger_entries_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "party_ledger_entries_customer_idx" ON "party_ledger_entries" USING btree ("tenant_id","customer_id","created_at");--> statement-breakpoint
ALTER TABLE "party_ledger_entries" ADD CONSTRAINT "party_ledger_entries_party" CHECK (("party_ledger_entries"."supplier_id" IS NULL) <> ("party_ledger_entries"."customer_id" IS NULL));--> statement-breakpoint

-- Hand-written part.
SELECT app_enable_tenant_rls('customers');
--> statement-breakpoint
SELECT app_enable_tenant_rls('invoice_sequences');
--> statement-breakpoint
-- Customers are archived, never deleted; counters only ever go up.
GRANT SELECT, INSERT, UPDATE ON customers, invoice_sequences TO app_user;
