CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "expense_categories_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "expense_categories_name_length" CHECK (char_length("expense_categories"."name") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"method" text NOT NULL,
	"paid_on" date NOT NULL,
	"description" text NOT NULL,
	"reference" text,
	"status" text DEFAULT 'posted' NOT NULL,
	"void_reason" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "expenses_amount" CHECK ("expenses"."amount_paise" > 0 AND "expenses"."amount_paise" <= 100000000000),
	CONSTRAINT "expenses_method" CHECK ("expenses"."method" in ('cash', 'upi', 'card', 'bank')),
	CONSTRAINT "expenses_status" CHECK ("expenses"."status" in ('posted', 'voided')),
	CONSTRAINT "expenses_void_fields" CHECK (("expenses"."status" = 'voided') = ("expenses"."void_reason" IS NOT NULL AND "expenses"."voided_at" IS NOT NULL AND "expenses"."voided_by" IS NOT NULL)),
	CONSTRAINT "expenses_text_lengths" CHECK (char_length("expenses"."description") between 1 and 200 AND char_length("expenses"."reference") <= 60 AND char_length("expenses"."void_reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."expense_categories"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_tenant_name_key" ON "expense_categories" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE INDEX "expenses_tenant_paid_on_idx" ON "expenses" USING btree ("tenant_id","paid_on");--> statement-breakpoint

-- Hand-written part.
SELECT app_enable_tenant_rls('expense_categories');
--> statement-breakpoint
SELECT app_enable_tenant_rls('expenses');
--> statement-breakpoint

-- An expense is never edited; the only change is posted -> voided with the
-- void fields (business rules 16). Not SECURITY DEFINER.
CREATE FUNCTION app_expense_only_void() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.status <> 'posted' OR NEW.status <> 'voided'
     OR (to_jsonb(NEW) - ARRAY['status', 'void_reason', 'voided_at', 'voided_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'void_reason', 'voided_at', 'voided_by']) THEN
    RAISE EXCEPTION 'an expense cannot be changed, only voided' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_expense_only_void() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER expenses_only_void BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION app_expense_only_void();
--> statement-breakpoint
CREATE TRIGGER expenses_no_delete BEFORE DELETE OR TRUNCATE ON expenses
  FOR EACH STATEMENT EXECUTE FUNCTION app_block_change();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON expense_categories, expenses TO app_user;
--> statement-breakpoint

-- New permission "Record expenses" (owner decision 2026-10-03, business
-- rules 16). Same pattern as migration 0014: RLS binds migrator too, so
-- temporary policies allow these inserts and are dropped straight away.
CREATE POLICY tmp_add_permission ON permissions AS PERMISSIVE FOR INSERT TO migrator WITH CHECK (true);
--> statement-breakpoint
INSERT INTO permissions (code, description) VALUES ('expenses.manage', 'Record expenses');
--> statement-breakpoint
DROP POLICY tmp_add_permission ON permissions;
--> statement-breakpoint
CREATE POLICY tmp_backfill_roles ON roles AS PERMISSIVE FOR SELECT TO migrator USING (true);
--> statement-breakpoint
CREATE POLICY tmp_backfill_grants ON role_permissions AS PERMISSIVE FOR ALL TO migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, 'expenses.manage'
  FROM roles r
 WHERE r.is_system AND r.name IN ('Owner', 'Admin', 'Manager')
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions rp
      WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id AND rp.permission_code = 'expenses.manage'
   );
--> statement-breakpoint
DROP POLICY tmp_backfill_grants ON role_permissions;
--> statement-breakpoint
DROP POLICY tmp_backfill_roles ON roles;
