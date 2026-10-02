-- Login tables: row-level security and privileges (ADR 0003).
--
-- auth_service (Better Auth only) reaches the login tables and nothing else.
-- app_user cannot see sessions, password hashes, tokens, rate-limit counters
-- or the security log at all. Both are enforced again by check-rls.

-- 1. Forced RLS on the new tables.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE verifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE verifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE rate_limits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE security_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- 2. Policies for auth_service. Login runs before anyone is known, so
--    within these tables the library may use every row.
CREATE POLICY auth_service_all ON users AS PERMISSIVE FOR ALL TO auth_service USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_service_all ON sessions AS PERMISSIVE FOR ALL TO auth_service USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_service_all ON accounts AS PERMISSIVE FOR ALL TO auth_service USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_service_all ON verifications AS PERMISSIVE FOR ALL TO auth_service USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_service_all ON rate_limits AS PERMISSIVE FOR ALL TO auth_service USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY auth_service_insert ON security_events AS PERMISSIVE FOR INSERT TO auth_service WITH CHECK (true);
--> statement-breakpoint

-- 3. auth_service privileges: login tables only. Users are disabled, never
--    deleted; sessions and tokens are deleted when revoked or used.
GRANT SELECT, INSERT, UPDATE ON users TO auth_service;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, accounts, verifications, rate_limits TO auth_service;
--> statement-breakpoint
GRANT INSERT ON security_events TO auth_service;
--> statement-breakpoint

-- 4. Identities are created only by Better Auth now: app_user may still read
--    and update users (its existing policies), but no longer create them.
REVOKE INSERT ON users FROM app_user;
--> statement-breakpoint
DROP POLICY user_insert ON users;
--> statement-breakpoint

-- 5. The security log can only grow (triggers block UPDATE/DELETE/TRUNCATE
--    for every role, and created_at comes from the database clock).
SELECT app_make_append_only('security_events');
