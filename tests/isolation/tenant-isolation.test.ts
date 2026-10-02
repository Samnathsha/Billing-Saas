import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { createTenantContext, withTenant, type TenantContext } from "@/db/with-tenant";
import { createFullTestBusiness, type FullTestBusiness } from "../helpers/business";

// Blueprint 5.1 layer 5: Business A attacks Business B in every table that
// has a tenant_id, as app_user through withTenant, exactly as app code
// would. Any attack must either be refused or affect zero rows.

// Every table with tenant_id. The first test checks this list against the
// database, so a new tenant table cannot be forgotten here.
const TENANT_TABLES = [
  "audit_logs",
  "branches",
  "devices",
  "memberships",
  "role_permissions",
  "roles",
  "settings",
  "sync_operations",
] as const;
type TenantTable = (typeof TENANT_TABLES)[number];

let a: FullTestBusiness;
let b: FullTestBusiness;

beforeAll(async () => {
  a = await createFullTestBusiness("Isolation shop A");
  b = await createFullTestBusiness("Isolation shop B");
});

afterAll(async () => {
  await getDb().$client.end();
});

function rowId(biz: FullTestBusiness, table: TenantTable): string {
  const id = biz.rowIds[table];
  if (id === undefined) throw new Error(`fixture has no row for ${table}`);
  return id;
}

async function asTenant(ctx: TenantContext, query: SQL): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  const result = await withTenant(ctx, (tx) => tx.execute(query));
  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

async function countAs(ctx: TenantContext, query: SQL): Promise<number> {
  const { rows } = await asTenant(ctx, query);
  return Number(rows[0]?.n);
}

// "Refused" means PostgreSQL said no: RLS, missing privilege, or the
// append-only trigger. Any other error (e.g. a unique-key clash) would mean
// the attack got further than it should, so it fails the test.
const REFUSED = /row-level security|permission denied|append-only/;

async function outcome(work: Promise<unknown>): Promise<string> {
  try {
    const result = await work;
    const rowCount = (result as { rowCount?: number }).rowCount ?? 0;
    return `ran: ${String(rowCount)} row(s)`;
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const message = cause instanceof Error ? cause.message : String(cause);
    return REFUSED.test(message) ? "refused" : `unexpected error: ${message}`;
  }
}

describe("the attack list covers every tenant table", () => {
  it("matches the tables with a tenant_id column in the database", async () => {
    const { rows } = await getDb().$client.query<{ table: string }>(
      `SELECT c.relname AS table FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute att ON att.attrelid = c.oid AND att.attname = 'tenant_id' AND NOT att.attisdropped
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
    );
    // If this fails after adding a table: add it to TENANT_TABLES and give
    // createFullTestBusiness a row for it.
    expect(rows.map((r) => r.table)).toEqual([...TENANT_TABLES]);
  });
});

describe.each(TENANT_TABLES)("Business A attacks Business B in %s", (table) => {
  const t = sql.identifier(table);

  it("cannot read B's rows", async () => {
    expect(await countAs(a.ctx, sql`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = ${b.ctx.tenantId}`)).toBe(0);
  });

  it("cannot read B's row by its exact id", async () => {
    expect(await countAs(a.ctx, sql`SELECT count(*)::int AS n FROM ${t} WHERE id = ${rowId(b, table)}`)).toBe(0);
  });

  it("counting everything counts only A's rows", async () => {
    expect(await countAs(a.ctx, sql`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id <> ${a.ctx.tenantId}`)).toBe(0);
    expect(await countAs(a.ctx, sql`SELECT count(*)::int AS n FROM ${t}`)).toBeGreaterThan(0);
  });

  it("cannot update B's rows", async () => {
    const result = await outcome(
      asTenant(a.ctx, sql`UPDATE ${t} SET tenant_id = tenant_id WHERE tenant_id = ${b.ctx.tenantId}`),
    );
    expect(["ran: 0 row(s)", "refused"]).toContain(result);
  });

  it("cannot delete B's rows", async () => {
    const result = await outcome(asTenant(a.ctx, sql`DELETE FROM ${t} WHERE tenant_id = ${b.ctx.tenantId}`));
    expect(["ran: 0 row(s)", "refused"]).toContain(result);
  });

  it("cannot move its own row into B", async () => {
    const result = await outcome(
      asTenant(a.ctx, sql`UPDATE ${t} SET tenant_id = ${b.ctx.tenantId} WHERE id = ${rowId(a, table)}`),
    );
    expect(result).toBe("refused");
  });

  it("cannot insert a row carrying B's tenant_id (forged)", async () => {
    // Copies A's own row, swapping in a new id and B's tenant_id.
    const forged = sql`
      INSERT INTO ${t}
      SELECT (jsonb_populate_record(NULL::${t},
                to_jsonb(r) || jsonb_build_object('id', gen_random_uuid(), 'tenant_id', ${b.ctx.tenantId}::uuid))).*
        FROM ${t} r WHERE r.id = ${rowId(a, table)}`;
    expect(await outcome(asTenant(a.ctx, forged))).toBe("refused");
  });

  it("B's row is still there and unchanged afterwards", async () => {
    const { rows } = await asTenant(b.ctx, sql`SELECT tenant_id FROM ${t} WHERE id = ${rowId(b, table)}`);
    expect(rows).toEqual([{ tenant_id: b.ctx.tenantId }]);
  });
});

describe("no business set: nothing is visible", () => {
  it.each([...TENANT_TABLES, "tenants", "users"])("a query on %s outside withTenant returns zero rows", async (table) => {
    const result = await getDb().execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`);
    expect(Number(result.rows[0]?.n)).toBe(0);
  });
});

describe("businesses and users", () => {
  it("A sees only its own business", async () => {
    const { rows } = await asTenant(a.ctx, sql`SELECT id FROM tenants`);
    expect(rows).toEqual([{ id: a.ctx.tenantId }]);
  });

  it("A cannot rename B", async () => {
    const result = await outcome(asTenant(a.ctx, sql`UPDATE tenants SET name = 'hacked' WHERE id = ${b.ctx.tenantId}`));
    expect(["ran: 0 row(s)", "refused"]).toContain(result);
  });

  it("A sees only its own people", async () => {
    const { rows } = await asTenant(a.ctx, sql`SELECT id FROM users`);
    expect(rows).toEqual([{ id: a.ctx.userId }]);
  });

  it("A cannot change B's user", async () => {
    const result = await outcome(
      asTenant(a.ctx, sql`UPDATE users SET display_name = 'hacked' WHERE id = ${b.ctx.userId}`),
    );
    expect(["ran: 0 row(s)", "refused"]).toContain(result);
  });

  it("A cannot create a business under another id", async () => {
    const result = await outcome(
      asTenant(a.ctx, sql`INSERT INTO tenants (id, name, template) VALUES (${randomUUID()}, 'Fake', 'clothing')`),
    );
    expect(result).toBe("refused");
  });
});

describe("mismatched context: business A with B's user", () => {
  // The session code (Phase 3) must never build this; if it ever did, the
  // database still shows nothing of B.
  const mixed = (): TenantContext => createTenantContext({ tenantId: a.ctx.tenantId, userId: b.ctx.userId });

  it("does not reveal B's business", async () => {
    const { rows } = await asTenant(mixed(), sql`SELECT id FROM tenants`);
    expect(rows).toEqual([{ id: a.ctx.tenantId }]);
  });

  it("does not reveal B's membership", async () => {
    expect(await countAs(mixed(), sql`SELECT count(*)::int AS n FROM memberships WHERE tenant_id = ${b.ctx.tenantId}`)).toBe(0);
  });
});

describe("login (user set, no business chosen yet)", () => {
  async function asUserOnly(userId: string, query: SQL): Promise<Record<string, unknown>[]> {
    return getDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
      return (await tx.execute(query)).rows;
    });
  }

  it("B's user sees only B's membership and business", async () => {
    expect(await asUserOnly(b.ctx.userId, sql`SELECT tenant_id FROM memberships`)).toEqual([
      { tenant_id: b.ctx.tenantId },
    ]);
    expect(await asUserOnly(b.ctx.userId, sql`SELECT id FROM tenants`)).toEqual([{ id: b.ctx.tenantId }]);
  });

  it("sees no business data before a business is chosen", async () => {
    expect(await asUserOnly(b.ctx.userId, sql`SELECT count(*)::int AS n FROM branches`)).toEqual([{ n: 0 }]);
  });
});
