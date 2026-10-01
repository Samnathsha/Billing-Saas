-- Row-level security (Phase 2, step 3). Blueprint section 5.1, layer 3.
--
-- The app (app_user) sets the business and user for each transaction with
-- set_config('app.tenant_id', ..., true) and set_config('app.user_id', ...,
-- true) (src/db/with-tenant.ts). Transaction-local, so pooled connections
-- never carry one request's tenant into another. If nothing is set, the
-- helpers return NULL, which matches no row: a query outside withTenant
-- sees nothing.
--
-- RLS is FORCED on every table, so it also binds migrator (the owner).
-- There are no policies for migrator, so migrations cannot read or change
-- business data. A data migration that must, adds a temporary policy inside
-- its own migration and drops it at the end.
--
-- app_user gets access to a table only here, together with its policy.
-- Never use `drizzle-kit push`: it does not know about these policies.

-- 1. Current business and user for this transaction (NULL if not set).
CREATE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_current_tenant_id() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_current_user_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO app_user;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_user_id() TO app_user;
--> statement-breakpoint

-- 2. The RLS helper. Every table with a tenant_id column is set up with
--    SELECT app_enable_tenant_rls('table_name');
--    in the migration that creates it. Only migrator can run it.
CREATE FUNCTION app_enable_tenant_rls(target regclass) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR ALL TO app_user '
    'USING (tenant_id = (SELECT app_current_tenant_id())) '
    'WITH CHECK (tenant_id = (SELECT app_current_tenant_id()))',
    target);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_enable_tenant_rls(regclass) FROM PUBLIC;
--> statement-breakpoint

-- 3. Tables with tenant_id: the standard policy.
SELECT app_enable_tenant_rls('branches');
--> statement-breakpoint
SELECT app_enable_tenant_rls('devices');
--> statement-breakpoint
SELECT app_enable_tenant_rls('settings');
--> statement-breakpoint
SELECT app_enable_tenant_rls('roles');
--> statement-breakpoint
SELECT app_enable_tenant_rls('role_permissions');
--> statement-breakpoint
SELECT app_enable_tenant_rls('memberships');
--> statement-breakpoint
SELECT app_enable_tenant_rls('audit_logs');
--> statement-breakpoint
SELECT app_enable_tenant_rls('sync_operations');
--> statement-breakpoint

-- A user may also read their own memberships in any business: login needs
-- the list of businesses before one is chosen. Read-only.
CREATE POLICY own_memberships ON memberships AS PERMISSIVE FOR SELECT TO app_user
  USING (user_id = (SELECT app_current_user_id()));
--> statement-breakpoint

-- 4. tenants: its id IS the tenant id.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The current business, plus (read-only) the businesses the user belongs to.
CREATE POLICY tenant_read ON tenants AS PERMISSIVE FOR SELECT TO app_user
  USING (
    id = (SELECT app_current_tenant_id())
    OR id IN (SELECT m.tenant_id FROM memberships m
              WHERE m.user_id = (SELECT app_current_user_id()) AND m.status = 'active')
  );
--> statement-breakpoint
-- Creating a business: the app chooses the new id and sets it as the
-- current tenant first, so a business can only be created "as itself".
CREATE POLICY tenant_insert ON tenants AS PERMISSIVE FOR INSERT TO app_user
  WITH CHECK (id = (SELECT app_current_tenant_id()));
--> statement-breakpoint
CREATE POLICY tenant_update ON tenants AS PERMISSIVE FOR UPDATE TO app_user
  USING (id = (SELECT app_current_tenant_id()))
  WITH CHECK (id = (SELECT app_current_tenant_id()));
--> statement-breakpoint

-- 5. users: global identities, still protected.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Yourself, plus the people who belong to the current business.
CREATE POLICY user_read ON users AS PERMISSIVE FOR SELECT TO app_user
  USING (
    id = (SELECT app_current_user_id())
    OR id IN (SELECT m.user_id FROM memberships m
              WHERE m.tenant_id = (SELECT app_current_tenant_id()))
  );
--> statement-breakpoint
-- Only your own account can be created or changed. Login by email (before
-- any user is known) and invitations are designed with auth in Phase 3.
CREATE POLICY user_insert ON users AS PERMISSIVE FOR INSERT TO app_user
  WITH CHECK (id = (SELECT app_current_user_id()));
--> statement-breakpoint
CREATE POLICY user_update ON users AS PERMISSIVE FOR UPDATE TO app_user
  USING (id = (SELECT app_current_user_id()))
  WITH CHECK (id = (SELECT app_current_user_id()));
--> statement-breakpoint

-- 6. permissions: the fixed list. Readable by the app, never writable.
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE permissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY permission_read ON permissions AS PERMISSIVE FOR SELECT TO app_user USING (true);
--> statement-breakpoint

-- 7. rate_limits: no business data (hashed keys and counters, Phase 3).
--    RLS is forced for consistency; the app may use every row.
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE rate_limits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY rate_limit_all ON rate_limits AS PERMISSIVE FOR ALL TO app_user USING (true) WITH CHECK (true);
--> statement-breakpoint

-- 8. app_user privileges: only what each table needs. Rows that later
--    records point at (branches, devices, memberships, users, tenants) are
--    archived or disabled, never deleted. audit_logs and sync_operations
--    are append-only.
GRANT SELECT, INSERT, UPDATE ON tenants, users, branches, devices, settings, memberships TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON roles, rate_limits TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON role_permissions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_logs, sync_operations TO app_user;
--> statement-breakpoint
GRANT SELECT ON permissions TO app_user;
