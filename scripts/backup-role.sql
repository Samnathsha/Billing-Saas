-- The backup role (Phase 11; blueprint 13.2).
--
-- Run once in the Neon SQL Editor of the project to back up (production; you
-- may also try it on billing-dev), as the default owner (neondb_owner), like
-- scripts/db-roles.sql. Safe to run again. Then set its password with:
--   npx tsx scripts/set-backup-password.ts <dev|test|prod>
--
-- backup_reader may READ every row of every table, of every business:
-- row-level security hides other businesses' rows from every other role,
-- and a backup must contain them all. It can change nothing.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_reader') THEN
    CREATE ROLE backup_reader WITH LOGIN BYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO backup_reader', current_database());
END
$$;

-- Read-only access to all data (a built-in PostgreSQL role).
GRANT pg_read_all_data TO backup_reader;

-- Stop with an error if it is more powerful than intended.
DO $$
DECLARE
  unsafe text;
BEGIN
  SELECT string_agg(rolname, ', ') INTO unsafe
  FROM pg_roles
  WHERE rolname = 'backup_reader'
    AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR NOT rolcanlogin OR NOT rolbypassrls);
  IF unsafe IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe settings on backup_reader. Ask for help before continuing.';
  END IF;

  SELECT string_agg(g.rolname, ', ') INTO unsafe
  FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.member
  JOIN pg_roles g ON g.oid = m.roleid
  WHERE r.rolname = 'backup_reader' AND g.rolname <> 'pg_read_all_data';
  IF unsafe IS NOT NULL THEN
    RAISE EXCEPTION 'backup_reader is a member of: %. Ask for help before continuing.', unsafe;
  END IF;
END
$$;

-- Expected: one row; can_login, bypass_rls true; the others false.
SELECT rolname AS role, rolcanlogin AS can_login, rolbypassrls AS bypass_rls, rolsuper AS superuser, rolcreaterole AS create_role
FROM pg_roles WHERE rolname = 'backup_reader';
