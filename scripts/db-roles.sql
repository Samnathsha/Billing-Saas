-- Database roles (Phase 2, step 1).
--
-- Run once in EACH Neon project (billing-dev and billing-test): open the
-- project in the Neon console, go to SQL Editor, make sure the database is
-- "neondb" and the role is the default owner (neondb_owner), paste this whole
-- file and press Run. Safe to run again.
--
-- It creates two login roles WITHOUT passwords (so no secret is ever typed
-- into the SQL editor or its history). Set the passwords afterwards with:
--   npx tsx scripts/set-db-passwords.ts dev     (and then: test)
--
--   migrator      owns the tables and runs migrations. Used only by drizzle-kit.
--   app_user      what the running app connects as. Owns nothing, cannot
--                 bypass row-level security, cannot create anything.
--   auth_service  used only by the login library (Better Auth, ADR 0003).
--                 Same restrictions as app_user; reaches the login tables
--                 only, never business data.
--   Table privileges for app_user and auth_service are granted by the
--   migrations (as migrator), so they are versioned in Git with the tables.
--
-- Do NOT create these roles with Neon's "Roles" page: roles made there are
-- members of neon_superuser, which is far more power than app_user may have.

-- 1. Create the roles. New roles get the safe defaults: no superuser, no
--    BYPASSRLS, no CREATEDB, no CREATEROLE, no REPLICATION.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') THEN
    CREATE ROLE migrator WITH LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user WITH LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_service') THEN
    CREATE ROLE auth_service WITH LOGIN;
  END IF;
END
$$;

-- 2. Database and schema access.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO migrator, app_user, auth_service', current_database());
  -- migrator creates the "drizzle" schema that records applied migrations.
  EXECUTE format('GRANT CREATE ON DATABASE %I TO migrator', current_database());
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO migrator;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT USAGE ON SCHEMA public TO auth_service;

-- 3. Stop with an error if either role is more powerful than intended
--    (for example if it already existed with other settings).
DO $$
DECLARE
  unsafe text;
BEGIN
  SELECT string_agg(rolname, ', ') INTO unsafe
  FROM pg_roles
  WHERE rolname IN ('migrator', 'app_user', 'auth_service')
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR NOT rolcanlogin);
  IF unsafe IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe role settings on: %. Ask for help before continuing.', unsafe;
  END IF;

  SELECT string_agg(r.rolname || ' is a member of ' || g.rolname, '; ') INTO unsafe
  FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.member
  JOIN pg_roles g ON g.oid = m.roleid
  WHERE r.rolname IN ('migrator', 'app_user', 'auth_service');
  IF unsafe IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected role membership: %. Ask for help before continuing.', unsafe;
  END IF;
END
$$;

-- 4. Summary. Expected: three rows, every column false except can_login (true).
SELECT rolname AS role,
       rolcanlogin AS can_login,
       rolsuper AS superuser,
       rolbypassrls AS bypass_rls,
       rolcreaterole AS create_role,
       rolcreatedb AS create_db
FROM pg_roles
WHERE rolname IN ('migrator', 'app_user', 'auth_service')
ORDER BY rolname;
