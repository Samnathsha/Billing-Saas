import type pg from "pg";

// The checks behind scripts/check-rls.ts. Reads only the PostgreSQL catalog
// (table and policy definitions), never business data. Returns one plain
// sentence per problem; an empty list means everything is in order.

// SECURITY DEFINER functions run with their owner's rights and so can skip
// RLS. None are allowed unless listed here after review (with a reason).
const SECURITY_DEFINER_ALLOWLIST: readonly string[] = [];

type Row = Record<string, unknown>;

async function rows<T extends Row>(client: pg.ClientBase, text: string): Promise<T[]> {
  return (await client.query<T>(text)).rows;
}

export async function checkRls(client: pg.ClientBase): Promise<string[]> {
  const problems: string[] = [];

  // 1. Every table: RLS enabled AND forced.
  for (const t of await rows<{ table: string; enabled: boolean; forced: boolean }>(
    client,
    `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY 1`,
  )) {
    if (!t.enabled) problems.push(`Table ${t.table}: row-level security is not enabled.`);
    else if (!t.forced) problems.push(`Table ${t.table}: row-level security is enabled but not forced.`);
  }

  // 2. Tables with tenant_id: NOT NULL, and the standard isolation policy.
  for (const t of await rows<{ table: string; nullable: boolean; has_policy: boolean }>(
    client,
    `SELECT c.relname AS table, NOT a.attnotnull AS nullable,
            EXISTS (SELECT 1 FROM pg_policies p
                     WHERE p.schemaname = 'public' AND p.tablename = c.relname
                       AND p.policyname = 'tenant_isolation' AND p.cmd = 'ALL'
                       AND p.roles = '{app_user}'
                       AND p.qual LIKE '%tenant_id = ( SELECT app_current_tenant_id()%'
                       AND p.with_check LIKE '%tenant_id = ( SELECT app_current_tenant_id()%') AS has_policy
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY 1`,
  )) {
    if (t.nullable) problems.push(`Table ${t.table}: tenant_id allows NULL.`);
    if (!t.has_policy) {
      problems.push(`Table ${t.table}: missing the standard tenant_isolation policy (use app_enable_tenant_rls).`);
    }
  }

  // 3. Policies only for app_user (a policy for migrator or PUBLIC opens a
  //    way around RLS).
  for (const p of await rows<{ table: string; policy: string; roles: string }>(
    client,
    `SELECT tablename AS table, policyname AS policy, array_to_string(roles, ',') AS roles
       FROM pg_policies
      WHERE schemaname = 'public' AND roles <> '{app_user}'
      ORDER BY 1, 2`,
  )) {
    problems.push(`Policy ${p.policy} on ${p.table} applies to "${p.roles}"; policies may only target app_user.`);
  }

  // 4. Foreign keys between two tenant tables must include tenant_id.
  for (const fk of await rows<{ constraint: string; table: string; target: string }>(
    client,
    `SELECT con.conname AS constraint, src.relname AS table, dst.relname AS target
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_class dst ON dst.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = src.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = src.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = dst.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
        AND NOT EXISTS (SELECT 1 FROM unnest(con.conkey) k
                          JOIN pg_attribute a ON a.attrelid = src.oid AND a.attnum = k
                         WHERE a.attname = 'tenant_id')
      ORDER BY 2, 1`,
  )) {
    problems.push(
      `Foreign key ${fk.constraint} (${fk.table} -> ${fk.target}) does not include tenant_id; use a composite key (tenant_id, id).`,
    );
  }

  // 5. Views run with the owner's rights unless security_invoker is on, and
  //    then skip RLS.
  for (const v of await rows<{ view: string }>(
    client,
    `SELECT c.relname AS view
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
        AND NOT coalesce('security_invoker=true' = ANY (c.reloptions), false)
      ORDER BY 1`,
  )) {
    problems.push(`View ${v.view} does not use security_invoker=true, so it would skip row-level security.`);
  }

  // 6. SECURITY DEFINER functions.
  for (const f of await rows<{ fn: string }>(
    client,
    `SELECT p.proname AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef ORDER BY 1`,
  )) {
    if (!SECURITY_DEFINER_ALLOWLIST.includes(f.fn)) {
      problems.push(`Function ${f.fn} is SECURITY DEFINER (runs with its owner's rights) and is not on the reviewed allow-list.`);
    }
  }

  // 7. app_user stays restricted.
  const [role] = await rows<{ unsafe: boolean; owns: number }>(
    client,
    `SELECT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb) AS unsafe,
            (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid)::int AS owns
       FROM pg_roles r WHERE r.rolname = 'app_user'`,
  );
  if (role === undefined) problems.push("Role app_user does not exist.");
  else {
    if (role.unsafe) problems.push("Role app_user has superuser, BYPASSRLS, CREATEROLE or CREATEDB.");
    if (role.owns > 0) problems.push(`Role app_user owns ${String(role.owns)} table(s) or other objects; it must own none.`);
  }

  return problems;
}
