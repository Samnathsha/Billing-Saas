CREATE TABLE "two_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" uuid NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "two_factors_user_idx" ON "two_factors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factors_secret_idx" ON "two_factors" USING btree ("secret");--> statement-breakpoint

-- Hand-written part (Phase 11, two-step login). Like the other login tables
-- (migration 0007): forced RLS, auth_service only; app_user never sees the
-- secrets.
ALTER TABLE two_factors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE two_factors FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY auth_service_all ON two_factors AS PERMISSIVE FOR ALL TO auth_service USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON two_factors TO auth_service;
--> statement-breakpoint

-- Only the login library (auth_service) may switch two-step login on or
-- off: app_user may update users (names, status) but not this column.
-- Not SECURITY DEFINER.
CREATE FUNCTION app_two_factor_flag_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF NEW.two_factor_enabled IS DISTINCT FROM OLD.two_factor_enabled AND current_user <> 'auth_service' THEN
    RAISE EXCEPTION 'two-step login can only be changed by the login service' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_two_factor_flag_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER users_two_factor_flag_guard BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app_two_factor_flag_guard();
