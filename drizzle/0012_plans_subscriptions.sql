CREATE TABLE "plans" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price_monthly_paise" bigint DEFAULT 0 NOT NULL,
	"max_branches" integer NOT NULL,
	"max_users" integer NOT NULL,
	"max_devices" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "plans_code_format" CHECK ("plans"."code" ~ '^[a-z0-9_]{1,30}$'),
	CONSTRAINT "plans_name_length" CHECK (char_length("plans"."name") between 1 and 100),
	CONSTRAINT "plans_price_not_negative" CHECK ("plans"."price_monthly_paise" >= 0),
	CONSTRAINT "plans_limits_positive" CHECK ("plans"."max_branches" >= 1 AND "plans"."max_users" >= 1 AND "plans"."max_devices" >= 0)
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_code" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "subscriptions_tenant_key" UNIQUE("tenant_id"),
	CONSTRAINT "subscriptions_status_valid" CHECK ("subscriptions"."status" in ('trialing', 'active', 'past_due', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_one_default" ON "plans" USING btree ("is_default") WHERE "plans"."is_default";--> statement-breakpoint

-- Hand-written part (owner decision 2026-10-02, business rules section 11).

-- 1. The pilot plan, inserted before RLS is switched on (like the
--    permissions list). Numbers can be changed later by a migration.
INSERT INTO plans (code, name, price_monthly_paise, max_branches, max_users, max_devices, is_default)
VALUES ('pilot', 'Pilot', 0, 2, 10, 5, true);
--> statement-breakpoint

-- 2. plans: readable by the app, never writable (like permissions).
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE plans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY plan_read ON plans AS PERMISSIVE FOR SELECT TO app_user USING (true);
--> statement-breakpoint
GRANT SELECT ON plans TO app_user;
--> statement-breakpoint

-- 3. subscriptions: standard tenant isolation. The app reads its own and
--    creates one with a new business; it never changes or deletes one.
SELECT app_enable_tenant_rls('subscriptions');
--> statement-breakpoint
GRANT SELECT, INSERT ON subscriptions TO app_user;
--> statement-breakpoint

-- 4. Every existing business gets the pilot plan. RLS binds migrator too,
--    so this data step adds temporary policies and drops them at once
--    (pattern from 0002). Afterwards every business has exactly one row.
CREATE POLICY tmp_backfill_read ON tenants AS PERMISSIVE FOR SELECT TO migrator USING (true);
--> statement-breakpoint
CREATE POLICY tmp_backfill_insert ON subscriptions AS PERMISSIVE FOR ALL TO migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
INSERT INTO subscriptions (tenant_id, plan_code, status)
SELECT t.id, 'pilot', 'active' FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id);
--> statement-breakpoint
DROP POLICY tmp_backfill_insert ON subscriptions;
--> statement-breakpoint
DROP POLICY tmp_backfill_read ON tenants;
