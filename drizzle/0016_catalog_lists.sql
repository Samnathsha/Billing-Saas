CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "brands_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "brands_name_length" CHECK (char_length("brands"."name") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "categories_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "categories_name_length" CHECK (char_length("categories"."name") between 1 and 100),
	CONSTRAINT "categories_not_own_parent" CHECK ("categories"."parent_id" IS NULL OR "categories"."parent_id" <> "categories"."id")
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"allows_fraction" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "units_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "units_name_length" CHECK (char_length("units"."name") between 1 and 50),
	CONSTRAINT "units_code_format" CHECK ("units"."code" ~ '^[A-Za-z0-9.]{1,10}$')
);
--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."categories"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brands_tenant_name_key" ON "brands" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "categories_tenant_name_key" ON "categories" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "units_tenant_name_key" ON "units" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "units_tenant_code_key" ON "units" USING btree ("tenant_id",lower("code"));--> statement-breakpoint

-- Hand-written part.

-- 1. Standard tenant isolation.
SELECT app_enable_tenant_rls('categories');
--> statement-breakpoint
SELECT app_enable_tenant_rls('brands');
--> statement-breakpoint
SELECT app_enable_tenant_rls('units');
--> statement-breakpoint

-- 2. Archived, never deleted: no DELETE grant.
GRANT SELECT, INSERT, UPDATE ON categories, brands, units TO app_user;
--> statement-breakpoint

-- 3. Every existing business gets the two starting units that new
--    businesses get (auth repo insertBusiness). Temporary policies, dropped
--    in this migration (pattern from 0012).
CREATE POLICY tmp_backfill_read ON tenants AS PERMISSIVE FOR SELECT TO migrator USING (true);
--> statement-breakpoint
CREATE POLICY tmp_backfill_units ON units AS PERMISSIVE FOR ALL TO migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
INSERT INTO units (tenant_id, name, code, allows_fraction)
SELECT t.id, u.name, u.code, u.allows_fraction
  FROM tenants t
 CROSS JOIN (VALUES ('Piece', 'pcs', false), ('Metre', 'm', true)) AS u(name, code, allows_fraction)
 WHERE NOT EXISTS (SELECT 1 FROM units x WHERE x.tenant_id = t.id AND lower(x.code) = u.code);
--> statement-breakpoint
DROP POLICY tmp_backfill_units ON units;
--> statement-breakpoint
DROP POLICY tmp_backfill_read ON tenants;
