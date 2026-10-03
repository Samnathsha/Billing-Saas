CREATE TABLE "stock_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"quantity" numeric(14, 3) DEFAULT '0' NOT NULL,
	"average_cost_paise" numeric(18, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stock_balances_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_balances_variant_branch_key" UNIQUE("tenant_id","variant_id","branch_id"),
	CONSTRAINT "stock_balances_not_negative" CHECK ("stock_balances"."quantity" >= 0),
	CONSTRAINT "stock_balances_cost" CHECK ("stock_balances"."average_cost_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"movement_type" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_cost_paise" numeric(18, 4) NOT NULL,
	"reason_code" text,
	"note" text,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_line_id" uuid NOT NULL,
	"serial_number_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_movements_source_key" UNIQUE("tenant_id","source_type","source_line_id","movement_type","serial_number_id"),
	CONSTRAINT "stock_movements_type_valid" CHECK ("stock_movements"."movement_type" in ('PURCHASE_IN','SALE_OUT','SALE_RETURN_IN','PURCHASE_RETURN_OUT','ADJUSTMENT_IN','ADJUSTMENT_OUT','TRANSFER_IN','TRANSFER_OUT','OPENING_STOCK','VOID_REVERSAL')),
	CONSTRAINT "stock_movements_sign" CHECK ("stock_movements"."quantity" <> 0 AND (
        ("stock_movements"."movement_type" in ('PURCHASE_IN','SALE_RETURN_IN','ADJUSTMENT_IN','TRANSFER_IN','OPENING_STOCK') AND "stock_movements"."quantity" > 0)
        OR ("stock_movements"."movement_type" in ('SALE_OUT','PURCHASE_RETURN_OUT','ADJUSTMENT_OUT','TRANSFER_OUT') AND "stock_movements"."quantity" < 0)
        OR "stock_movements"."movement_type" = 'VOID_REVERSAL')),
	CONSTRAINT "stock_movements_cost" CHECK ("stock_movements"."unit_cost_paise" >= 0),
	CONSTRAINT "stock_movements_reason" CHECK (("stock_movements"."movement_type" in ('ADJUSTMENT_IN','ADJUSTMENT_OUT')) = ("stock_movements"."reason_code" IS NOT NULL)
          AND ("stock_movements"."reason_code" IS NULL OR "stock_movements"."reason_code" in ('damaged','lost','found','count_correction','expired','other'))),
	CONSTRAINT "stock_movements_serial_one_unit" CHECK ("stock_movements"."serial_number_id" IS NULL OR abs("stock_movements"."quantity") = 1),
	CONSTRAINT "stock_movements_note_length" CHECK (char_length("stock_movements"."note") <= 500),
	CONSTRAINT "stock_movements_source_type" CHECK ("stock_movements"."source_type" ~ '^[a-z_]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" uuid NOT NULL,
	"operation" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_key" UNIQUE("tenant_id","key"),
	CONSTRAINT "idempotency_keys_operation_format" CHECK ("idempotency_keys"."operation" ~ '^[a-z_]+(\.[a-z_]+)+$')
);
--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_serial_fk" FOREIGN KEY ("tenant_id","serial_number_id") REFERENCES "public"."serial_numbers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_movements_tenant_variant_idx" ON "stock_movements" USING btree ("tenant_id","variant_id","branch_id","created_at");--> statement-breakpoint
SELECT app_enable_tenant_rls('stock_movements');
--> statement-breakpoint
SELECT app_enable_tenant_rls('stock_balances');
--> statement-breakpoint
SELECT app_enable_tenant_rls('idempotency_keys');
--> statement-breakpoint
-- The ledgers can only grow (UPDATE, DELETE and TRUNCATE blocked for
-- everyone by triggers; corrections are new reversing rows).
SELECT app_make_append_only('stock_movements');
--> statement-breakpoint
SELECT app_make_append_only('idempotency_keys');
--> statement-breakpoint
GRANT SELECT, INSERT ON stock_movements, idempotency_keys TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON stock_balances TO app_user;
