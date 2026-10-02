-- Absolute session timeout: 12 hours from login (owner decision 2026-10-02,
-- src/modules/auth/session-policy.ts).
--
-- Better Auth extends a session's expires_at while it is in use (the 30-minute
-- idle timeout) and has no built-in maximum age. This trigger caps expires_at
-- at created_at + 12 hours on every insert and update, so no extension can
-- pass that point. Better Auth checks expires_at on every request (cookie
-- cache off), so after 12 hours the session stops working everywhere,
-- including Better Auth's own endpoints (e.g. change password).
--
-- If the policy changes, change both this value (in a new migration) and
-- SESSION_POLICY.absoluteTimeoutSeconds; tests/integration/sessions.test.ts
-- checks they agree.

CREATE FUNCTION app_cap_session_lifetime() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  NEW.expires_at := LEAST(NEW.expires_at, NEW.created_at + interval '12 hours');
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_cap_session_lifetime() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER sessions_absolute_timeout BEFORE INSERT OR UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION app_cap_session_lifetime();
