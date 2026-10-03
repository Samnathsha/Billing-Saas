CREATE TABLE "purchase_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"tax_rate" numeric(7, 4) NOT NULL,
	"line_subtotal_paise" bigint NOT NULL,
	"line_tax_paise" bigint NOT NULL,
	"line_total_paise" bigint NOT NULL,
	"unit_cost_paise" numeric(18, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_items_quantity" CHECK ("purchase_items"."quantity" > 0),
	CONSTRAINT "purchase_items_price" CHECK ("purchase_items"."unit_price_paise" >= 0),
	CONSTRAINT "purchase_items_rate" CHECK ("purchase_items"."tax_rate" >= 0 AND "purchase_items"."tax_rate" <= 100),
	CONSTRAINT "purchase_items_totals" CHECK ("purchase_items"."line_tax_paise" >= 0 AND "purchase_items"."line_total_paise" = "purchase_items"."line_subtotal_paise" + "purchase_items"."line_tax_paise"),
	CONSTRAINT "purchase_items_cost" CHECK ("purchase_items"."unit_cost_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"supplier_invoice_number" text NOT NULL,
	"invoice_date" date NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"subtotal_paise" bigint NOT NULL,
	"tax_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"cost_basis" text NOT NULL,
	"note" text,
	"void_reason" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchases_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchases_status_valid" CHECK ("purchases"."status" in ('posted', 'voided')),
	CONSTRAINT "purchases_totals" CHECK ("purchases"."subtotal_paise" >= 0 AND "purchases"."tax_paise" >= 0 AND "purchases"."total_paise" = "purchases"."subtotal_paise" + "purchases"."tax_paise"),
	CONSTRAINT "purchases_cost_basis" CHECK ("purchases"."cost_basis" in ('excludes_tax', 'includes_tax')),
	CONSTRAINT "purchases_invoice_number" CHECK (char_length("purchases"."supplier_invoice_number") between 1 and 40),
	CONSTRAINT "purchases_void_fields" CHECK (("purchases"."status" = 'voided') = ("purchases"."void_reason" IS NOT NULL AND "purchases"."voided_at" IS NOT NULL AND "purchases"."voided_by" IS NOT NULL)),
	CONSTRAINT "purchases_text_lengths" CHECK (char_length("purchases"."note") <= 500 AND char_length("purchases"."void_reason") <= 500)
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"purchase_id" uuid,
	"amount_paise" bigint NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"paid_on" date NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_payments_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_payments_amount" CHECK ("supplier_payments"."amount_paise" > 0 AND "supplier_payments"."amount_paise" <= 100000000000),
	CONSTRAINT "supplier_payments_method" CHECK ("supplier_payments"."method" in ('cash', 'upi', 'bank', 'cheque')),
	CONSTRAINT "supplier_payments_reference_length" CHECK (char_length("supplier_payments"."reference") <= 100)
);
--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_fk" FOREIGN KEY ("tenant_id","purchase_id") REFERENCES "public"."purchases"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_purchase_fk" FOREIGN KEY ("tenant_id","purchase_id") REFERENCES "public"."purchases"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_items_purchase_idx" ON "purchase_items" USING btree ("tenant_id","purchase_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_supplier_invoice_key" ON "purchases" USING btree ("tenant_id","supplier_id",upper("supplier_invoice_number")) WHERE "purchases"."status" = 'posted';--> statement-breakpoint
CREATE INDEX "purchases_tenant_date_idx" ON "purchases" USING btree ("tenant_id","invoice_date");--> statement-breakpoint
CREATE INDEX "supplier_payments_supplier_idx" ON "supplier_payments" USING btree ("tenant_id","supplier_id","paid_on");--> statement-breakpoint

-- Hand-written part.
SELECT app_enable_tenant_rls('purchases');
--> statement-breakpoint
SELECT app_enable_tenant_rls('purchase_items');
--> statement-breakpoint
SELECT app_enable_tenant_rls('supplier_payments');
--> statement-breakpoint
SELECT app_make_append_only('purchase_items');
--> statement-breakpoint
SELECT app_make_append_only('supplier_payments');
--> statement-breakpoint

-- A posted purchase is never edited (CLAUDE.md, business rules 14): the
-- only allowed change is posted -> voided with the void fields. Not
-- SECURITY DEFINER: it only inspects the row being changed.
CREATE FUNCTION app_purchase_only_void() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.status <> 'posted' OR NEW.status <> 'voided'
     OR NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.supplier_id <> OLD.supplier_id
     OR NEW.branch_id <> OLD.branch_id OR NEW.supplier_invoice_number <> OLD.supplier_invoice_number
     OR NEW.invoice_date <> OLD.invoice_date OR NEW.subtotal_paise <> OLD.subtotal_paise
     OR NEW.tax_paise <> OLD.tax_paise OR NEW.total_paise <> OLD.total_paise
     OR NEW.cost_basis <> OLD.cost_basis OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a posted purchase cannot be changed, only voided' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_purchase_only_void() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER purchases_only_void BEFORE UPDATE ON purchases
  FOR EACH ROW EXECUTE FUNCTION app_purchase_only_void();
--> statement-breakpoint
CREATE TRIGGER purchases_no_delete BEFORE DELETE OR TRUNCATE ON purchases
  FOR EACH STATEMENT EXECUTE FUNCTION app_block_change();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON purchases TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON purchase_items, supplier_payments TO app_user;
