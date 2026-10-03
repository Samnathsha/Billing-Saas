CREATE TABLE "serial_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"serial" text NOT NULL,
	"status" text DEFAULT 'in_stock' NOT NULL,
	"branch_id" uuid,
	"purchase_item_id" uuid,
	"invoice_item_id" uuid,
	"warranty_ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "serial_numbers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "serial_numbers_format" CHECK ("serial_numbers"."serial" ~ '^[A-Za-z0-9-]{4,40}$'),
	CONSTRAINT "serial_numbers_status_valid" CHECK ("serial_numbers"."status" in ('in_stock', 'sold', 'returned', 'scrapped'))
);
--> statement-breakpoint
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "serial_numbers_tenant_serial_key" ON "serial_numbers" USING btree ("tenant_id",upper("serial"));--> statement-breakpoint
CREATE INDEX "serial_numbers_tenant_variant_idx" ON "serial_numbers" USING btree ("tenant_id","variant_id");--> statement-breakpoint
SELECT app_enable_tenant_rls('serial_numbers');
--> statement-breakpoint
-- Status changes over time; rows are never deleted (history of each unit).
GRANT SELECT, INSERT, UPDATE ON serial_numbers TO app_user;
