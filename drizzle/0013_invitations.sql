CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by" uuid NOT NULL,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "invitations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "invitations_tenant_token_key" UNIQUE("tenant_id","token_hash"),
	CONSTRAINT "invitations_email_lower" CHECK ("invitations"."email" = lower("invitations"."email") AND char_length("invitations"."email") between 3 and 254 AND "invitations"."email" like '%_@_%'),
	CONSTRAINT "invitations_token_hash_format" CHECK ("invitations"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "invitations_status_valid" CHECK ("invitations"."status" in ('pending', 'accepted', 'revoked')),
	CONSTRAINT "invitations_accepted_fields" CHECK (("invitations"."status" = 'accepted') = ("invitations"."accepted_by" IS NOT NULL AND "invitations"."accepted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_tenant_email_pending_key" ON "invitations" USING btree ("tenant_id","email") WHERE "invitations"."status" = 'pending';--> statement-breakpoint

-- Hand-written part.

-- 1. Standard tenant isolation (inside a business).
SELECT app_enable_tenant_rls('invitations');
--> statement-breakpoint

-- 2. Login view, like own_memberships (0004): before any business is chosen,
--    a user may READ invitations addressed to their own email, so accepting
--    can find the business from the invitation row, never from request
--    data. Inside a business this policy does not apply.
CREATE POLICY own_invitations ON invitations AS PERMISSIVE FOR SELECT TO app_user
  USING (
    (SELECT app_current_tenant_id()) IS NULL
    AND email = (SELECT lower(u.email) FROM users u WHERE u.id = (SELECT app_current_user_id()))
  );
--> statement-breakpoint

-- 3. The app creates invitations and marks them accepted or revoked; it
--    never deletes them (history).
GRANT SELECT, INSERT, UPDATE ON invitations TO app_user;
