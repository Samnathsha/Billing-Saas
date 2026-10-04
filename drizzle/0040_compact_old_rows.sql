-- Keeping the free database plan small (Phase 11, step 8). Removes rows
-- that only protect against a request being repeated and are useless once
-- old: synced till operations and idempotency keys after 90 days (a repeat
-- arrives within minutes; a bill's own id still refuses a duplicate), and
-- login rate-limit counters after 1 day. Bills, ledgers, stock movements,
-- audit and security logs are never touched.

-- 1. The append-only guard lets exactly this through: a DELETE on these two
--    technical tables, by the table owner, while the function below runs.
CREATE OR REPLACE FUNCTION app_block_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW'
     AND TG_TABLE_NAME IN ('sync_operations', 'idempotency_keys')
     AND current_user = 'migrator'
     AND current_setting('app.compacting', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed. Add a correcting row instead.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint

-- 2. The only SECURITY DEFINER function (reviewed; check-rls allow-list):
--    no arguments, fixed ages, only these three tables. It runs as the table
--    owner, lifts forced row-level security on them for its own
--    transaction, deletes, and forces it again. The app may call it (a
--    nightly maintenance request); the worst a caller can do is remove those
--    old technical rows a little early.
CREATE FUNCTION app_compact_old_rows() RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
  AS $$
DECLARE
  ops bigint;
  keys bigint;
  limits bigint;
BEGIN
  -- Never stall the tills: give up (and try again tomorrow) if busy.
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM set_config('app.compacting', 'on', true);
  ALTER TABLE sync_operations NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE idempotency_keys NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE rate_limits NO FORCE ROW LEVEL SECURITY;
  DELETE FROM sync_operations WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS ops = ROW_COUNT;
  DELETE FROM idempotency_keys WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS keys = ROW_COUNT;
  DELETE FROM rate_limits WHERE last_request < (extract(epoch FROM now() - interval '1 day') * 1000)::bigint;
  GET DIAGNOSTICS limits = ROW_COUNT;
  ALTER TABLE sync_operations FORCE ROW LEVEL SECURITY;
  ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
  ALTER TABLE rate_limits FORCE ROW LEVEL SECURITY;
  PERFORM set_config('app.compacting', 'off', true);
  RETURN jsonb_build_object('sync_operations', ops, 'idempotency_keys', keys, 'rate_limits', limits);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_compact_old_rows() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_compact_old_rows() TO app_user;
