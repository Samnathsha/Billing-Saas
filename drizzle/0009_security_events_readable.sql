-- The login library's role (auth_service) may now also READ the security log,
-- for the lockout tests and a future "security activity" screen. It already
-- holds every login secret (password hashes, sessions), so this adds no new
-- exposure. The log stays append-only for everyone (migration 0007 triggers);
-- app_user still has no access at all.
CREATE POLICY auth_service_read ON security_events AS PERMISSIVE FOR SELECT TO auth_service USING (true);
--> statement-breakpoint
GRANT SELECT ON security_events TO auth_service;
