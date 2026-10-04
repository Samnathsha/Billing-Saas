CREATE TABLE "purchase_return_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_return_id" uuid NOT NULL,
	"line_number" smallint NOT NULL,
	"purchase_item_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"subtotal_paise" bigint NOT NULL,
	"tax_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_return_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_return_items_line_key" UNIQUE("tenant_id","purchase_return_id","line_number"),
	CONSTRAINT "purchase_return_items_line_number" CHECK ("purchase_return_items"."line_number" between 1 and 200),
	CONSTRAINT "purchase_return_items_quantity" CHECK ("purchase_return_items"."quantity" > 0),
	CONSTRAINT "purchase_return_items_totals" CHECK ("purchase_return_items"."subtotal_paise" >= 0 AND "purchase_return_items"."tax_paise" >= 0 AND "purchase_return_items"."total_paise" = "purchase_return_items"."subtotal_paise" + "purchase_return_items"."tax_paise")
);
--> statement-breakpoint
CREATE TABLE "purchase_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"return_date" date NOT NULL,
	"reference" text,
	"reason" text NOT NULL,
	"subtotal_paise" bigint NOT NULL,
	"tax_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_returns_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_returns_totals" CHECK ("purchase_returns"."subtotal_paise" >= 0 AND "purchase_returns"."tax_paise" >= 0 AND "purchase_returns"."total_paise" = "purchase_returns"."subtotal_paise" + "purchase_returns"."tax_paise"),
	CONSTRAINT "purchase_returns_text_lengths" CHECK (char_length("purchase_returns"."reason") between 3 and 500 AND char_length("purchase_returns"."reference") <= 40)
);
--> statement-breakpoint
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_return_fk" FOREIGN KEY ("tenant_id","purchase_return_id") REFERENCES "public"."purchase_returns"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_item_fk" FOREIGN KEY ("tenant_id","purchase_item_id") REFERENCES "public"."purchase_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_purchase_fk" FOREIGN KEY ("tenant_id","purchase_id") REFERENCES "public"."purchases"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_return_items_item_idx" ON "purchase_return_items" USING btree ("tenant_id","purchase_item_id");--> statement-breakpoint
CREATE INDEX "purchase_returns_purchase_idx" ON "purchase_returns" USING btree ("tenant_id","purchase_id");--> statement-breakpoint

-- Hand-written part.
SELECT app_enable_tenant_rls('purchase_returns');
--> statement-breakpoint
SELECT app_enable_tenant_rls('purchase_return_items');
--> statement-breakpoint
SELECT app_make_append_only('purchase_returns');
--> statement-breakpoint
SELECT app_make_append_only('purchase_return_items');
--> statement-breakpoint
GRANT SELECT, INSERT ON purchase_returns, purchase_return_items TO app_user;
