import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { rateLimits } from "@/db/schema";
import { withTenant } from "@/db/with-tenant";
import { compactOldRows } from "@/modules/maintenance";
import { createFullTestBusiness } from "../helpers/business";

// Nightly maintenance (Phase 11; migration 0040): old technical rows go,
// everything else stays, and the protections are back afterwards.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

// Makes rows look old, as the table owner would (test set-up only).
const AGE_SQL: Record<string, string> = {
  sync_operations: "UPDATE sync_operations SET created_at = now() - interval '100 days' WHERE tenant_id = $1",
  idempotency_keys: "UPDATE idempotency_keys SET created_at = now() - interval '100 days' WHERE tenant_id = $1",
};
const LIFT: Record<string, string[]> = {
  sync_operations: ["ALTER TABLE sync_operations NO FORCE ROW LEVEL SECURITY", "ALTER TABLE sync_operations DISABLE TRIGGER USER"],
  idempotency_keys: ["ALTER TABLE idempotency_keys NO FORCE ROW LEVEL SECURITY", "ALTER TABLE idempotency_keys DISABLE TRIGGER USER"],
};
const RESTORE: Record<string, string[]> = {
  sync_operations: ["ALTER TABLE sync_operations ENABLE TRIGGER USER", "ALTER TABLE sync_operations FORCE ROW LEVEL SECURITY"],
  idempotency_keys: ["ALTER TABLE idempotency_keys ENABLE TRIGGER USER", "ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY"],
};

async function makeOld(tenantId: string): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL_TEST });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const table of ["sync_operations", "idempotency_keys"]) {
      for (const q of LIFT[table] ?? []) await client.query(q);
      await client.query(AGE_SQL[table] ?? "", [tenantId]);
      for (const q of RESTORE[table] ?? []) await client.query(q);
    }
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
}

describe("removing old technical rows", () => {
  it("removes repeat-protection rows older than 90 days and old login counters; keeps everything else; protections come back", async () => {
    const old = await createFullTestBusiness("Compact old");
    const recent = await createFullTestBusiness("Compact recent");
    await makeOld(old.ctx.tenantId);
    const oldKey = `old-${randomUUID()}`;
    const newKey = `new-${randomUUID()}`;
    await getAuthDb().insert(rateLimits).values([
      { key: oldKey, count: 1, lastRequest: Date.now() - 2 * 86_400_000 },
      { key: newKey, count: 1, lastRequest: Date.now() },
    ]);
    const counts = (ctx: typeof old.ctx) =>
      withTenant(ctx, (tx) =>
        tx.execute(sql`SELECT (SELECT count(*) FROM sync_operations)::int AS ops, (SELECT count(*) FROM idempotency_keys)::int AS keys,
                              (SELECT count(*) FROM audit_logs)::int AS audit, (SELECT count(*) FROM invoices)::int AS invoices`),
      ).then((r) => r.rows[0]);
    expect(await counts(old.ctx)).toEqual({ ops: 1, keys: 1, audit: 1, invoices: 1 });

    const removed = await compactOldRows();
    expect(removed.sync_operations).toBeGreaterThanOrEqual(1);
    expect(removed.idempotency_keys).toBeGreaterThanOrEqual(1);
    expect(removed.rate_limits).toBeGreaterThanOrEqual(1);
    expect(await counts(old.ctx)).toEqual({ ops: 0, keys: 0, audit: 1, invoices: 1 });
    expect(await counts(recent.ctx)).toEqual({ ops: 1, keys: 1, audit: 1, invoices: 1 });
    const left = await getAuthDb().select({ key: rateLimits.key }).from(rateLimits).where(sql`${rateLimits.key} IN (${oldKey}, ${newKey})`);
    expect(left).toEqual([{ key: newKey }]);

    const forced = await getDb().execute<{ name: string; forced: boolean }>(
      sql`SELECT relname AS name, relforcerowsecurity AS forced FROM pg_class WHERE relname IN ('sync_operations', 'idempotency_keys', 'rate_limits') ORDER BY 1`,
    );
    expect(forced.rows.every((r) => r.forced)).toBe(true);
  });

  it("the app itself still cannot delete those rows, even pretending to compact", async () => {
    const biz = await createFullTestBusiness("Compact guard");
    await expect(
      withTenant(biz.ctx, async (tx) => {
        await tx.execute(sql`SELECT set_config('app.compacting', 'on', true)`);
        await tx.execute(sql`DELETE FROM sync_operations`);
      }),
    ).rejects.toThrow();
    await expect(withTenant(biz.ctx, (tx) => tx.execute(sql`DELETE FROM idempotency_keys`))).rejects.toThrow();
  });
});
