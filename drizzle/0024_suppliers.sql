CREATE TABLE "party_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid,
	"entry_type" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_ledger_entries_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "party_ledger_entries_source_key" UNIQUE("tenant_id","source_type","source_id","entry_type"),
	CONSTRAINT "party_ledger_entries_party" CHECK ("party_ledger_entries"."supplier_id" IS NOT NULL),
	CONSTRAINT "party_ledger_entries_type_valid" CHECK ("party_ledger_entries"."entry_type" in ('opening', 'invoice', 'payment', 'return', 'purchase', 'purchase_return', 'adjustment', 'void_reversal')),
	CONSTRAINT "party_ledger_entries_amount_not_zero" CHECK ("party_ledger_entries"."amount_paise" <> 0),
	CONSTRAINT "party_ledger_entries_note_length" CHECK (char_length("party_ledger_entries"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"gstin" text,
	"state_code" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "suppliers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "suppliers_name_length" CHECK (char_length("suppliers"."name") between 1 and 200),
	CONSTRAINT "suppliers_phone_format" CHECK ("suppliers"."phone" ~ '^[+0-9 -]{6,20}$'),
	CONSTRAINT "suppliers_gstin_format" CHECK ("suppliers"."gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
	CONSTRAINT "suppliers_state_code_format" CHECK ("suppliers"."state_code" ~ '^[0-9]{2}$'),
	CONSTRAINT "suppliers_gstin_matches_state" CHECK ("suppliers"."gstin" IS NULL OR ("suppliers"."state_code" IS NOT NULL AND left("suppliers"."gstin", 2) = "suppliers"."state_code"))
);
--> statement-breakpoint
ALTER TABLE "party_ledger_entries" ADD CONSTRAINT "party_ledger_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_ledger_entries" ADD CONSTRAINT "party_ledger_entries_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "party_ledger_entries_supplier_idx" ON "party_ledger_entries" USING btree ("tenant_id","supplier_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_tenant_name_key" ON "suppliers" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
SELECT app_enable_tenant_rls('suppliers');
--> statement-breakpoint
SELECT app_enable_tenant_rls('party_ledger_entries');
--> statement-breakpoint
SELECT app_make_append_only('party_ledger_entries');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON suppliers TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON party_ledger_entries TO app_user;
