CREATE TABLE "sync_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"invoice_id" uuid,
	"credit_note_id" uuid,
	"code" text NOT NULL,
	"detail" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_flags_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "sync_flags_one_document" CHECK (("sync_flags"."invoice_id" IS NULL) <> ("sync_flags"."credit_note_id" IS NULL)),
	CONSTRAINT "sync_flags_code_valid" CHECK ("sync_flags"."code" in ('stock_short', 'price_changed', 'tax_changed', 'settings_changed', 'discount_over_limit', 'item_archived', 'imei_unavailable', 'role_removed', 'date_corrected', 'number_gap', 'return_after_window', 'refund_differs')),
	CONSTRAINT "sync_flags_status_valid" CHECK ("sync_flags"."status" in ('open', 'resolved')),
	CONSTRAINT "sync_flags_resolved_fields" CHECK (("sync_flags"."status" = 'resolved') = ("sync_flags"."resolved_at" IS NOT NULL AND "sync_flags"."resolved_by" IS NOT NULL AND "sync_flags"."resolution_note" IS NOT NULL)),
	CONSTRAINT "sync_flags_note_length" CHECK (char_length("sync_flags"."resolution_note") between 3 and 500)
);
--> statement-breakpoint
ALTER TABLE "stock_balances" DROP CONSTRAINT "stock_balances_not_negative";--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "offline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "synced_by" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "offline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "synced_by" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "prefix" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "revoked_by" uuid;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "offline_window_hours" integer DEFAULT 72 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_flags" ADD CONSTRAINT "sync_flags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_flags" ADD CONSTRAINT "sync_flags_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."devices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_flags" ADD CONSTRAINT "sync_flags_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_flags" ADD CONSTRAINT "sync_flags_credit_note_fk" FOREIGN KEY ("tenant_id","credit_note_id") REFERENCES "public"."credit_notes"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_flags_open_idx" ON "sync_flags" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."devices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."devices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_device_date_idx" ON "invoices" USING btree ("tenant_id","device_id","invoice_date");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_token_hash_key" ON "devices" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_prefix_key" UNIQUE("tenant_id","prefix");--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_offline_fields" CHECK (("credit_notes"."offline_at" IS NULL) = ("credit_notes"."synced_by" IS NULL) AND ("credit_notes"."offline_at" IS NULL OR "credit_notes"."device_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_offline_fields" CHECK (("invoices"."offline_at" IS NULL) = ("invoices"."synced_by" IS NULL) AND ("invoices"."offline_at" IS NULL OR "invoices"."device_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_prefix_format" CHECK ("devices"."prefix" ~ '^[A-Z0-9]{1,3}$');--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_token_hash_format" CHECK ("devices"."token_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_registered" CHECK (("devices"."prefix" IS NULL) = ("devices"."token_hash" IS NULL));--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_revoked_fields" CHECK (("devices"."status" = 'revoked') = ("devices"."revoked_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_offline_window_range" CHECK ("settings"."offline_window_hours" between 1 and 720);--> statement-breakpoint

-- Hand-written part (decision 0006, offline tills).
SELECT app_enable_tenant_rls('sync_flags');
--> statement-breakpoint

-- A flag is never edited or deleted; the only change is open -> resolved
-- with who, when and a note. Not SECURITY DEFINER.
CREATE FUNCTION app_sync_flag_only_resolve() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.status <> 'open' OR NEW.status <> 'resolved'
     OR (to_jsonb(NEW) - ARRAY['status', 'resolved_at', 'resolved_by', 'resolution_note'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'resolved_at', 'resolved_by', 'resolution_note']) THEN
    RAISE EXCEPTION 'a sync flag cannot be changed, only resolved' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_sync_flag_only_resolve() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER sync_flags_only_resolve BEFORE UPDATE ON sync_flags
  FOR EACH ROW EXECUTE FUNCTION app_sync_flag_only_resolve();
--> statement-breakpoint
CREATE TRIGGER sync_flags_no_delete BEFORE DELETE OR TRUNCATE ON sync_flags
  FOR EACH STATEMENT EXECUTE FUNCTION app_block_change();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON sync_flags TO app_user;
--> statement-breakpoint

-- A till's prefix and token, once given, never change (its bills carry the
-- prefix), and a revoked till stays revoked: a stolen till cannot be
-- brought back. Not SECURITY DEFINER.
CREATE FUNCTION app_device_rules() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'a revoked till cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.prefix IS NOT NULL AND (NEW.prefix IS DISTINCT FROM OLD.prefix OR NEW.token_hash IS DISTINCT FROM OLD.token_hash) THEN
    RAISE EXCEPTION 'a till''s prefix and token cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_device_rules() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER devices_rules BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION app_device_rules();
--> statement-breakpoint

-- New permission "Manage tills" (register and revoke tills, review offline
-- flags; business rules 17: a manager registers tills). Same pattern as
-- migration 0036.
CREATE POLICY tmp_add_permission ON permissions AS PERMISSIVE FOR INSERT TO migrator WITH CHECK (true);
--> statement-breakpoint
INSERT INTO permissions (code, description) VALUES ('tills.manage', 'Manage tills and offline flags');
--> statement-breakpoint
DROP POLICY tmp_add_permission ON permissions;
--> statement-breakpoint
CREATE POLICY tmp_backfill_roles ON roles AS PERMISSIVE FOR SELECT TO migrator USING (true);
--> statement-breakpoint
CREATE POLICY tmp_backfill_grants ON role_permissions AS PERMISSIVE FOR ALL TO migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, 'tills.manage'
  FROM roles r
 WHERE r.is_system AND r.name IN ('Owner', 'Admin', 'Manager')
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions rp
      WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id AND rp.permission_code = 'tills.manage'
   );
--> statement-breakpoint
DROP POLICY tmp_backfill_grants ON role_permissions;
--> statement-breakpoint
DROP POLICY tmp_backfill_roles ON roles;
