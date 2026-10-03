CREATE TABLE "credit_note_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"line_number" smallint NOT NULL,
	"invoice_item_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"serial_number_id" uuid,
	"quantity" numeric(14, 3) NOT NULL,
	"resellable" boolean NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_note_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "credit_note_items_line_key" UNIQUE("tenant_id","credit_note_id","line_number"),
	CONSTRAINT "credit_note_items_line_number" CHECK ("credit_note_items"."line_number" between 1 and 500),
	CONSTRAINT "credit_note_items_quantity" CHECK ("credit_note_items"."quantity" > 0 AND ("credit_note_items"."serial_number_id" IS NULL OR "credit_note_items"."quantity" = 1)),
	CONSTRAINT "credit_note_items_money" CHECK ("credit_note_items"."taxable_paise" >= 0 AND "credit_note_items"."cgst_paise" >= 0 AND "credit_note_items"."cgst_paise" = "credit_note_items"."sgst_paise" AND "credit_note_items"."igst_paise" >= 0 AND "credit_note_items"."taxable_paise" + "credit_note_items"."cgst_paise" + "credit_note_items"."sgst_paise" + "credit_note_items"."igst_paise" = "credit_note_items"."total_paise")
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"number" text NOT NULL,
	"prefix" text NOT NULL,
	"financial_year" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"credit_note_date" date NOT NULL,
	"customer_id" uuid,
	"refund_method" text NOT NULL,
	"reason" text NOT NULL,
	"outside_window" boolean NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"tax_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"round_off_paise" bigint NOT NULL,
	"refund_paise" bigint NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_notes_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "credit_notes_number_key" UNIQUE("tenant_id","number"),
	CONSTRAINT "credit_notes_sequence_key" UNIQUE("tenant_id","prefix","financial_year","sequence_number"),
	CONSTRAINT "credit_notes_method" CHECK ("credit_notes"."refund_method" in ('cash', 'card', 'upi', 'store_credit')),
	CONSTRAINT "credit_notes_store_credit_needs_customer" CHECK ("credit_notes"."refund_method" <> 'store_credit' OR "credit_notes"."customer_id" IS NOT NULL),
	CONSTRAINT "credit_notes_number_format" CHECK (char_length("credit_notes"."number") <= 16 AND "credit_notes"."sequence_number" between 1 and 99999),
	CONSTRAINT "credit_notes_reason_length" CHECK (char_length("credit_notes"."reason") between 3 and 500),
	CONSTRAINT "credit_notes_money" CHECK ("credit_notes"."taxable_paise" >= 0 AND "credit_notes"."cgst_paise" >= 0 AND "credit_notes"."cgst_paise" = "credit_notes"."sgst_paise" AND "credit_notes"."igst_paise" >= 0 AND "credit_notes"."cgst_paise" + "credit_notes"."sgst_paise" + "credit_notes"."igst_paise" = "credit_notes"."tax_paise" AND "credit_notes"."taxable_paise" + "credit_notes"."tax_paise" = "credit_notes"."total_paise"),
	CONSTRAINT "credit_notes_round_off" CHECK ("credit_notes"."round_off_paise" between -49 and 50 AND "credit_notes"."refund_paise" = "credit_notes"."total_paise" + "credit_notes"."round_off_paise" AND "credit_notes"."refund_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "return_window_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_credit_note_fk" FOREIGN KEY ("tenant_id","credit_note_id") REFERENCES "public"."credit_notes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_invoice_item_fk" FOREIGN KEY ("tenant_id","invoice_item_id") REFERENCES "public"."invoice_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_serial_fk" FOREIGN KEY ("tenant_id","serial_number_id") REFERENCES "public"."serial_numbers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_note_items_invoice_item_idx" ON "credit_note_items" USING btree ("tenant_id","invoice_item_id");--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_idx" ON "credit_notes" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE INDEX "credit_notes_tenant_date_idx" ON "credit_notes" USING btree ("tenant_id","credit_note_date");--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_return_window_range" CHECK ("settings"."return_window_days" between 0 and 365);--> statement-breakpoint

-- Hand-written part.
SELECT app_enable_tenant_rls('credit_notes');
--> statement-breakpoint
SELECT app_enable_tenant_rls('credit_note_items');
--> statement-breakpoint
SELECT app_make_append_only('credit_notes');
--> statement-breakpoint
SELECT app_make_append_only('credit_note_items');
--> statement-breakpoint
GRANT SELECT, INSERT ON credit_notes, credit_note_items TO app_user;
