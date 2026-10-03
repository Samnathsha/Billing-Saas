CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"selling_price_paise" bigint NOT NULL,
	"mrp_paise" bigint,
	"cost_price_paise" bigint,
	"reorder_level" numeric(14, 3) DEFAULT '0' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "product_variants_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "product_variants_sku_format" CHECK ("product_variants"."sku" ~ '^[A-Za-z0-9._/-]{1,40}$'),
	CONSTRAINT "product_variants_price_range" CHECK ("product_variants"."selling_price_paise" between 1 and 1000000000),
	CONSTRAINT "product_variants_mrp" CHECK ("product_variants"."mrp_paise" IS NULL OR ("product_variants"."mrp_paise" >= "product_variants"."selling_price_paise" AND "product_variants"."mrp_paise" <= 1000000000)),
	CONSTRAINT "product_variants_cost" CHECK ("product_variants"."cost_price_paise" IS NULL OR "product_variants"."cost_price_paise" between 0 and 1000000000),
	CONSTRAINT "product_variants_reorder" CHECK ("product_variants"."reorder_level" >= 0),
	CONSTRAINT "product_variants_attributes_object" CHECK (jsonb_typeof("product_variants"."attributes") = 'object')
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid,
	"brand_id" uuid,
	"unit_id" uuid NOT NULL,
	"hsn_code" text,
	"tax_category" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"track_serial" boolean DEFAULT false NOT NULL,
	"warranty_months" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "products_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "products_name_length" CHECK (char_length("products"."name") between 1 and 200),
	CONSTRAINT "products_hsn_format" CHECK ("products"."hsn_code" ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
	CONSTRAINT "products_warranty_range" CHECK ("products"."warranty_months" between 0 and 120),
	CONSTRAINT "products_attributes_object" CHECK (jsonb_typeof("products"."attributes") = 'object')
);
--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tax_category_tax_categories_code_fk" FOREIGN KEY ("tax_category") REFERENCES "public"."tax_categories"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."categories"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "public"."brands"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_tenant_sku_key" ON "product_variants" USING btree ("tenant_id",lower("sku"));--> statement-breakpoint
CREATE INDEX "product_variants_tenant_product_idx" ON "product_variants" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE INDEX "products_tenant_name_idx" ON "products" USING btree ("tenant_id",lower("name"));--> statement-breakpoint

-- Hand-written part.
SELECT app_enable_tenant_rls('products');
--> statement-breakpoint
SELECT app_enable_tenant_rls('product_variants');
--> statement-breakpoint
-- Archived, never deleted (sales will point at variants).
GRANT SELECT, INSERT, UPDATE ON products, product_variants TO app_user;
