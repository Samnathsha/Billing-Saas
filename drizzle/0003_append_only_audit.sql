-- Append-only tables (Phase 2, step 5). Blueprint 5.5 and CLAUDE.md: the
-- audit trail and ledgers are never updated or deleted; mistakes are fixed
-- by adding a new row.
--
-- Two independent locks:
--   1. app_user has no UPDATE, DELETE or TRUNCATE privilege (revoked below,
--      in case one is ever granted by mistake).
--   2. Triggers refuse UPDATE, DELETE and TRUNCATE for EVERY role, including
--      migrator (the owner). Removing them takes a migration, visible in Git.
-- An insert trigger also stamps created_at with the database clock, so an
-- entry cannot be backdated.

-- 1. Trigger functions.
CREATE FUNCTION app_block_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed. Add a correcting row instead.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE FUNCTION app_stamp_created_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_block_change() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_stamp_created_at() FROM PUBLIC;
--> statement-breakpoint

-- 2. The helper. Future ledgers (stock_movements, party_ledger_entries...)
--    call SELECT app_make_append_only('table'); in their migration.
CREATE FUNCTION app_make_append_only(target regclass) RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
  AS $$
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM app_user', target);
  EXECUTE format(
    'CREATE TRIGGER append_only_block_row BEFORE UPDATE OR DELETE ON %s '
    'FOR EACH ROW EXECUTE FUNCTION app_block_change()', target);
  EXECUTE format(
    'CREATE TRIGGER append_only_block_truncate BEFORE TRUNCATE ON %s '
    'FOR EACH STATEMENT EXECUTE FUNCTION app_block_change()', target);
  EXECUTE format(
    'CREATE TRIGGER append_only_stamp_created_at BEFORE INSERT ON %s '
    'FOR EACH ROW EXECUTE FUNCTION app_stamp_created_at()', target);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_make_append_only(regclass) FROM PUBLIC;
--> statement-breakpoint

-- 3. Apply.
SELECT app_make_append_only('audit_logs');
--> statement-breakpoint
SELECT app_make_append_only('sync_operations');
