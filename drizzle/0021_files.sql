CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"product_id" uuid,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sha256" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "files_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "files_storage_key_key" UNIQUE("tenant_id","storage_key"),
	CONSTRAINT "files_purpose_valid" CHECK ("files"."purpose" in ('logo', 'product_image')),
	CONSTRAINT "files_product_matches_purpose" CHECK (("files"."purpose" = 'product_image') = ("files"."product_id" IS NOT NULL)),
	CONSTRAINT "files_content_type_valid" CHECK ("files"."content_type" in ('image/webp', 'image/png', 'image/jpeg')),
	CONSTRAINT "files_size_range" CHECK ("files"."size_bytes" between 1 and 2097152),
	CONSTRAINT "files_sha256_format" CHECK ("files"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "files_storage_key_format" CHECK ("files"."storage_key" ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.webp$')
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_tenant_product_idx" ON "files" USING btree ("tenant_id","product_id");--> statement-breakpoint
SELECT app_enable_tenant_rls('files');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON files TO app_user;
