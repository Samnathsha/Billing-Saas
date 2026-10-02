import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkRls } from "../../scripts/lib/check-rls-core";

// check-rls must pass on the migrated database and catch each kind of
// weakness. Each weakness is created by migrator inside a transaction that
// is always rolled back, so nothing is left behind.

let migrator: pg.Client;

beforeAll(async () => {
  const url = process.env.MIGRATOR_DATABASE_URL_TEST;
  if (url === undefined || url === "") throw new Error("MIGRATOR_DATABASE_URL_TEST must be set for database tests");
  migrator = new pg.Client({ connectionString: url });
  await migrator.connect();
});

afterAll(async () => {
  await migrator.end();
});

async function problemsAfter(...statements: string[]): Promise<string[]> {
  await migrator.query("BEGIN");
  try {
    for (const statement of statements) await migrator.query(statement);
    return await checkRls(migrator);
  } finally {
    await migrator.query("ROLLBACK");
  }
}

describe("check-rls", () => {
  it("passes on the migrated database", async () => {
    expect(await checkRls(migrator)).toEqual([]);
  });

  it("catches a table without row-level security", async () => {
    expect(await problemsAfter("CREATE TABLE zz_plain (id int)")).toContain(
      "Table zz_plain: row-level security is not enabled.",
    );
  });

  it("catches RLS that is enabled but not forced", async () => {
    expect(
      await problemsAfter("CREATE TABLE zz_soft (id int)", "ALTER TABLE zz_soft ENABLE ROW LEVEL SECURITY"),
    ).toContain("Table zz_soft: row-level security is enabled but not forced.");
  });

  it("catches a tenant table without the isolation policy", async () => {
    const problems = await problemsAfter(
      "CREATE TABLE zz_tenant (id uuid, tenant_id uuid NOT NULL)",
      "ALTER TABLE zz_tenant ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE zz_tenant FORCE ROW LEVEL SECURITY",
    );
    expect(problems).toContain(
      "Table zz_tenant: missing the standard tenant_isolation policy (use app_enable_tenant_rls).",
    );
  });

  it("catches a nullable tenant_id", async () => {
    const problems = await problemsAfter(
      "CREATE TABLE zz_nullable (id uuid, tenant_id uuid)",
      "SELECT app_enable_tenant_rls('zz_nullable')",
    );
    expect(problems).toContain("Table zz_nullable: tenant_id allows NULL.");
  });

  it("accepts a table set up the standard way", async () => {
    expect(
      await problemsAfter(
        "CREATE TABLE zz_good (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)",
        "SELECT app_enable_tenant_rls('zz_good')",
      ),
    ).toEqual([]);
  });

  it("catches a policy for a role other than app_user", async () => {
    const problems = await problemsAfter(
      "CREATE POLICY zz_backdoor ON branches FOR SELECT TO migrator USING (true)",
    );
    expect(problems).toContain('Policy zz_backdoor on branches applies to "migrator"; policies may only target app_user.');
  });

  it("catches a foreign key between tenant tables that skips tenant_id", async () => {
    const problems = await problemsAfter(
      "CREATE TABLE zz_child (id uuid, tenant_id uuid NOT NULL, branch_id uuid REFERENCES branches(id))",
      "SELECT app_enable_tenant_rls('zz_child')",
    );
    expect(problems.some((p) => p.includes("(zz_child -> branches) does not include tenant_id"))).toBe(true);
  });

  it("catches a view that would skip RLS", async () => {
    expect(await problemsAfter("CREATE VIEW zz_view AS SELECT id FROM branches")).toContain(
      "View zz_view does not use security_invoker=true, so it would skip row-level security.",
    );
  });

  it("accepts a security_invoker view", async () => {
    expect(
      await problemsAfter("CREATE VIEW zz_safe_view WITH (security_invoker = true) AS SELECT id FROM branches"),
    ).toEqual([]);
  });

  it("catches a SECURITY DEFINER function", async () => {
    const problems = await problemsAfter(
      "CREATE FUNCTION zz_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'",
    );
    expect(problems.some((p) => p.startsWith("Function zz_definer is SECURITY DEFINER"))).toBe(true);
  });
});
