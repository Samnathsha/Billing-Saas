CREATE TABLE "invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_number" smallint NOT NULL,
	"variant_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"variant_label" text NOT NULL,
	"sku" text NOT NULL,
	"hsn_code" text,
	"unit_code" text NOT NULL,
	"serial_number_id" uuid,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"tax_category" text NOT NULL,
	"tax_label" text NOT NULL,
	"tax_rate" numeric(7, 4) NOT NULL,
	"gross_paise" bigint NOT NULL,
	"line_discount_paise" bigint NOT NULL,
	"bill_discount_paise" bigint NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"unit_cost_paise" numeric(18, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoice_items_line_key" UNIQUE("tenant_id","invoice_id","line_number"),
	CONSTRAINT "invoice_items_line_number" CHECK ("invoice_items"."line_number" between 1 and 500),
	CONSTRAINT "invoice_items_quantity" CHECK ("invoice_items"."quantity" > 0 AND ("invoice_items"."serial_number_id" IS NULL OR "invoice_items"."quantity" = 1)),
	CONSTRAINT "invoice_items_rate" CHECK ("invoice_items"."tax_rate" >= 0 AND "invoice_items"."tax_rate" <= 100),
	CONSTRAINT "invoice_items_money" CHECK ("invoice_items"."unit_price_paise" >= 0 AND "invoice_items"."line_discount_paise" >= 0 AND "invoice_items"."bill_discount_paise" >= 0 AND "invoice_items"."taxable_paise" >= 0 AND "invoice_items"."cgst_paise" = "invoice_items"."sgst_paise" AND "invoice_items"."igst_paise" >= 0 AND "invoice_items"."cgst_paise" >= 0),
	CONSTRAINT "invoice_items_totals" CHECK ("invoice_items"."taxable_paise" + "invoice_items"."cgst_paise" + "invoice_items"."sgst_paise" + "invoice_items"."igst_paise" = "invoice_items"."total_paise" AND "invoice_items"."line_discount_paise" + "invoice_items"."bill_discount_paise" <= "invoice_items"."gross_paise"),
	CONSTRAINT "invoice_items_cost" CHECK ("invoice_items"."unit_cost_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reference" text,
	"kind" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_payments_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoice_payments_method" CHECK ("invoice_payments"."method" in ('cash', 'card', 'upi')),
	CONSTRAINT "invoice_payments_kind" CHECK (("invoice_payments"."kind" = 'sale' AND "invoice_payments"."amount_paise" > 0) OR ("invoice_payments"."kind" = 'void' AND "invoice_payments"."amount_paise" < 0)),
	CONSTRAINT "invoice_payments_amount" CHECK (abs("invoice_payments"."amount_paise") <= 100000000000),
	CONSTRAINT "invoice_payments_reference_length" CHECK (char_length("invoice_payments"."reference") <= 100)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"number" text NOT NULL,
	"prefix" text NOT NULL,
	"financial_year" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"invoice_date" date NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"seller_name" text NOT NULL,
	"seller_gstin" text,
	"seller_state_code" text NOT NULL,
	"gst_registration" text NOT NULL,
	"prices_include_tax" boolean NOT NULL,
	"charges_gst" boolean NOT NULL,
	"customer_id" uuid,
	"buyer_name" text,
	"buyer_phone" text,
	"buyer_address" text,
	"buyer_gstin" text,
	"place_of_supply" text NOT NULL,
	"inter_state" boolean NOT NULL,
	"gross_paise" bigint NOT NULL,
	"discount_paise" bigint NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"tax_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"round_off_paise" bigint NOT NULL,
	"payable_paise" bigint NOT NULL,
	"paid_paise" bigint NOT NULL,
	"credit_paise" bigint NOT NULL,
	"void_reason" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoices_number_key" UNIQUE("tenant_id","number"),
	CONSTRAINT "invoices_sequence_key" UNIQUE("tenant_id","prefix","financial_year","sequence_number"),
	CONSTRAINT "invoices_status_valid" CHECK ("invoices"."status" in ('posted', 'voided')),
	CONSTRAINT "invoices_registration" CHECK ("invoices"."gst_registration" in ('registered', 'composition', 'unregistered')),
	CONSTRAINT "invoices_charges_gst" CHECK ("invoices"."charges_gst" = ("invoices"."gst_registration" = 'registered')),
	CONSTRAINT "invoices_number_format" CHECK (char_length("invoices"."number") <= 16 AND "invoices"."sequence_number" between 1 and 99999),
	CONSTRAINT "invoices_state_codes" CHECK ("invoices"."seller_state_code" ~ '^[0-9]{2}$' AND "invoices"."place_of_supply" ~ '^[0-9]{2}$'),
	CONSTRAINT "invoices_inter_state" CHECK ("invoices"."inter_state" = ("invoices"."place_of_supply" <> "invoices"."seller_state_code")),
	CONSTRAINT "invoices_money_non_negative" CHECK ("invoices"."gross_paise" >= 0 AND "invoices"."discount_paise" >= 0 AND "invoices"."taxable_paise" >= 0 AND "invoices"."cgst_paise" >= 0 AND "invoices"."igst_paise" >= 0 AND "invoices"."paid_paise" >= 0 AND "invoices"."credit_paise" >= 0),
	CONSTRAINT "invoices_totals" CHECK ("invoices"."taxable_paise" + "invoices"."tax_paise" = "invoices"."total_paise" AND "invoices"."cgst_paise" = "invoices"."sgst_paise" AND "invoices"."cgst_paise" + "invoices"."sgst_paise" + "invoices"."igst_paise" = "invoices"."tax_paise" AND "invoices"."discount_paise" <= "invoices"."gross_paise"),
	CONSTRAINT "invoices_no_gst_when_not_charged" CHECK ("invoices"."charges_gst" OR "invoices"."tax_paise" = 0),
	CONSTRAINT "invoices_split_by_place" CHECK (("invoices"."inter_state" AND "invoices"."cgst_paise" = 0) OR (NOT "invoices"."inter_state" AND "invoices"."igst_paise" = 0)),
	CONSTRAINT "invoices_round_off" CHECK ("invoices"."round_off_paise" between -49 and 50 AND "invoices"."payable_paise" = "invoices"."total_paise" + "invoices"."round_off_paise"),
	CONSTRAINT "invoices_paid_and_credit" CHECK ("invoices"."paid_paise" + "invoices"."credit_paise" = "invoices"."payable_paise"),
	CONSTRAINT "invoices_credit_needs_customer" CHECK ("invoices"."credit_paise" = 0 OR "invoices"."customer_id" IS NOT NULL),
	CONSTRAINT "invoices_void_fields" CHECK (("invoices"."status" = 'voided') = ("invoices"."void_reason" IS NOT NULL AND "invoices"."voided_at" IS NOT NULL AND "invoices"."voided_by" IS NOT NULL)),
	CONSTRAINT "invoices_text_lengths" CHECK (char_length("invoices"."seller_name") <= 200 AND char_length("invoices"."buyer_name") <= 200 AND char_length("invoices"."buyer_address") <= 500 AND char_length("invoices"."void_reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_serial_fk" FOREIGN KEY ("tenant_id","serial_number_id") REFERENCES "public"."serial_numbers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_payments_invoice_idx" ON "invoice_payments" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_tenant_date_idx" ON "invoices" USING btree ("tenant_id","invoice_date");--> statement-breakpoint
CREATE INDEX "invoices_customer_idx" ON "invoices" USING btree ("tenant_id","customer_id");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_address_length" CHECK (char_length("customers"."address") <= 500);--> statement-breakpoint

-- Hand-written part.
SELECT app_enable_tenant_rls('invoices');
--> statement-breakpoint
SELECT app_enable_tenant_rls('invoice_items');
--> statement-breakpoint
SELECT app_enable_tenant_rls('invoice_payments');
--> statement-breakpoint
SELECT app_make_append_only('invoice_items');
--> statement-breakpoint
SELECT app_make_append_only('invoice_payments');
--> statement-breakpoint

-- A posted bill is never edited (CLAUDE.md, business rules 6): the only
-- allowed change is posted -> voided with the void fields. Not SECURITY
-- DEFINER: it only inspects the row being changed.
CREATE FUNCTION app_invoice_only_void() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.status <> 'posted' OR NEW.status <> 'voided'
     OR (to_jsonb(NEW) - ARRAY['status', 'void_reason', 'voided_at', 'voided_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'void_reason', 'voided_at', 'voided_by']) THEN
    RAISE EXCEPTION 'a posted bill cannot be changed, only voided' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_invoice_only_void() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER invoices_only_void BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION app_invoice_only_void();
--> statement-breakpoint
CREATE TRIGGER invoices_no_delete BEFORE DELETE OR TRUNCATE ON invoices
  FOR EACH STATEMENT EXECUTE FUNCTION app_block_change();
--> statement-breakpoint
-- The bill line a serial number was sold on (column since migration 0020).
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_invoice_item_fk"
  FOREIGN KEY ("tenant_id", "invoice_item_id") REFERENCES "invoice_items" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON invoices TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON invoice_items, invoice_payments TO app_user;
