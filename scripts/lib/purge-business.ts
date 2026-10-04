import type pg from "pg";

// Removes ONE business's data for good, after its owner asked and the grace
// period passed (Phase 11; tenants.deletion_due_at). Run as the table owner
// (migrator), never by the app.
//
// Bills, ledgers and logs are protected by row-level security (forced, even
// for the owner) and by triggers that refuse deletes. Inside ONE
// transaction this lifts both on each affected table, deletes only the rows
// of that business, and puts both back; a failure
// anywhere rolls everything back, protections included. The app's own role
// (app_user) owns nothing and can do none of this.

export interface PurgeResult {
  businessName: string;
  dueAt: string;
  rows: Record<string, number>;
  deleted: boolean;
}

export class PurgeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurgeRefused";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Constant SQL only: table and column names arrive as transaction-local
// settings and are quoted by PostgreSQL itself (format %I), values by %L.
const PROTECTIONS_SQL = `DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY string_to_array(current_setting('app.purge_tables'), ',') LOOP
    IF current_setting('app.purge_protect') = 'off' THEN
      EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', t);
    ELSE
      EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER', t);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END
$$`;

const COUNT_SQL = `SELECT t AS name,
  (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I WHERE tenant_id = %L', t, $1::uuid), false, true, '')))[1]::text::int AS n
  FROM unnest($2::text[]) AS t`;

// Some tables point at each other (a sold IMEI and its bill line), so no
// "children first" order exists: the links between the purged tables are
// set aside (definitions kept), the rows deleted, and the links put back,
// which makes PostgreSQL check every remaining row again.
const SET_ASIDE_LINKS_SQL = `DO $$
DECLARE r record;
BEGIN
  CREATE TEMP TABLE purge_links ON COMMIT DROP AS
    SELECT con.conrelid::regclass::text AS tbl, con.conname AS name, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
     WHERE con.contype = 'f'
       AND con.conrelid::regclass::text = ANY(string_to_array(current_setting('app.purge_tables'), ','))
       AND con.confrelid::regclass::text = ANY(string_to_array(current_setting('app.purge_tables'), ','));
  FOR r IN SELECT * FROM purge_links LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.name);
  END LOOP;
END
$$`;

const RESTORE_LINKS_SQL = `DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM purge_links LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.tbl, r.name, r.def);
  END LOOP;
END
$$`;

const DELETE_SQL = `DO $$
BEGIN
  EXECUTE format('DELETE FROM public.%I WHERE tenant_id = %L', current_setting('app.purge_table'), current_setting('app.purge_tenant'));
END
$$`;

async function protections(client: pg.Client, tables: string[], on: boolean): Promise<void> {
  await client.query("SELECT set_config('app.purge_tables', $1, true), set_config('app.purge_protect', $2, true)", [tables.join(","), on ? "on" : "off"]);
  await client.query(PROTECTIONS_SQL);
}

async function deleteRows(client: pg.Client, tenantId: string, table: string): Promise<void> {
  await client.query("SELECT set_config('app.purge_table', $1, true), set_config('app.purge_tenant', $2, true)", [table, tenantId]);
  await client.query(DELETE_SQL);
}

// Tables with a tenant_id.
async function tenantTables(client: pg.Client): Promise<string[]> {
  const r = await client.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
  );
  return r.rows.map((row) => row.name);
}

export async function purgeBusiness(client: pg.Client, tenantId: string, opts: { confirmName: string | null; now?: Date }): Promise<PurgeResult> {
  if (!UUID.test(tenantId)) throw new PurgeRefused("That is not a business id.");
  const who = await client.query<{ me: string }>("SELECT current_user AS me");
  if (who.rows[0]?.me !== "migrator") throw new PurgeRefused("Run this as the migrator role (MIGRATOR_DATABASE_URL_...).");

  await client.query("BEGIN");
  try {
    const tables = await tenantTables(client);
    const all = [...tables, "tenants"];
    // Lift the protections, inside this transaction only.
    await protections(client, all, false);
    const business = await client.query<{ name: string; due: Date | null }>("SELECT name, deletion_due_at AS due FROM tenants WHERE id = $1", [tenantId]);
    const row = business.rows[0];
    if (row === undefined) throw new PurgeRefused("No business with that id.");
    if (row.due === null) throw new PurgeRefused(`"${row.name}" has not asked to be deleted.`);
    if (row.due.getTime() > (opts.now ?? new Date()).getTime()) throw new PurgeRefused(`"${row.name}" may be deleted only after ${row.due.toISOString()}.`);

    const counted = await client.query<{ name: string; n: number }>(COUNT_SQL, [tenantId, tables]);
    const rows: Record<string, number> = Object.fromEntries(counted.rows.map((r) => [r.name, r.n]));
    const result: PurgeResult = { businessName: row.name, dueAt: row.due.toISOString(), rows, deleted: false };
    if (opts.confirmName === null) {
      await client.query("ROLLBACK");
      return result;
    }
    if (opts.confirmName !== row.name) throw new PurgeRefused("The name given does not match the business.");

    await client.query("SELECT set_config('app.purge_tables', $1, true)", [all.join(",")]);
    await client.query(SET_ASIDE_LINKS_SQL);
    for (const t of tables) await deleteRows(client, tenantId, t);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query(RESTORE_LINKS_SQL);

    // Protections back on, then checked.
    await protections(client, all, true);
    const weak = await client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c WHERE c.relname = ANY($1::text[]) AND c.relnamespace = 'public'::regnamespace
         AND (NOT c.relforcerowsecurity OR EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal AND tg.tgenabled = 'D'))`,
      [all],
    );
    if (weak.rows.length > 0) throw new Error(`purge: protections not restored on ${weak.rows.map((r) => r.name).join(", ")}`);
    await client.query("COMMIT");
    return { ...result, deleted: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
