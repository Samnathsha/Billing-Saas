CREATE TABLE "barcodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "barcodes_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "barcodes_code_format" CHECK ("barcodes"."code" ~ '^[A-Za-z0-9-]{1,64}$')
);
--> statement-breakpoint
DROP INDEX "products_tenant_name_idx";--> statement-breakpoint
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "barcodes_tenant_code_active_key" ON "barcodes" USING btree ("tenant_id","code") WHERE "barcodes"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "barcodes_tenant_variant_idx" ON "barcodes" USING btree ("tenant_id","variant_id");--> statement-breakpoint
CREATE INDEX "products_tenant_name_idx" ON "products" USING btree ("tenant_id",lower("name") text_pattern_ops);--> statement-breakpoint
SELECT app_enable_tenant_rls('barcodes');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON barcodes TO app_user;
