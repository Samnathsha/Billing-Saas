import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { authServiceUrl, createFullTestBusiness, type FullTestBusiness } from "../helpers/business";

// ADR 0003: the login library's role (auth_service) reaches only the login
// tables, and the app's role (app_user) can never see login secrets.

const BUSINESS_TABLES = [
  "tenants",
  "memberships",
  "roles",
  "role_permissions",
  "branches",
  "devices",
  "settings",
  "audit_logs",
  "sync_operations",
  "permissions",
  "plans",
  "subscriptions",
  "invitations",
  "tax_categories",
  "tax_rates",
  "categories",
  "brands",
  "units",
  "products",
  "product_variants",
  "barcodes",
] as const;
const LOGIN_SECRET_TABLES = ["sessions", "accounts", "verifications", "rate_limits", "security_events"] as const;

let biz: FullTestBusiness;
let auth: pg.Client;
const sessionToken = `test-token-${randomUUID()}`;

beforeAll(async () => {
  biz = await createFullTestBusiness("Login tables shop");
  auth = new pg.Client({ connectionString: authServiceUrl() });
  await auth.connect();
  // What Better Auth will do at sign-up and login.
  await auth.query(
    "INSERT INTO accounts (account_id, provider_id, user_id, password) VALUES ($1, 'credential', $2, $3)",
    [biz.ctx.userId, biz.ctx.userId, "$argon2id$v=19$m=19456,t=2,p=1$fake-test-hash"],
  );
  await auth.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')", [
    sessionToken,
    biz.ctx.userId,
  ]);
  await auth.query("INSERT INTO security_events (event, user_id) VALUES ('auth.login_succeeded', $1)", [biz.ctx.userId]);
});

afterAll(async () => {
  await auth.end();
  await getDb().$client.end();
});

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "no error";
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return cause instanceof Error ? cause.message : String(cause);
  }
}

// Fixed statements (no SQL built from strings, per the lint rule).
const SELECT_SQL: Record<string, string> = {
  tenants: "SELECT count(*) FROM tenants",
  memberships: "SELECT count(*) FROM memberships",
  roles: "SELECT count(*) FROM roles",
  role_permissions: "SELECT count(*) FROM role_permissions",
  branches: "SELECT count(*) FROM branches",
  devices: "SELECT count(*) FROM devices",
  settings: "SELECT count(*) FROM settings",
  audit_logs: "SELECT count(*) FROM audit_logs",
  sync_operations: "SELECT count(*) FROM sync_operations",
  permissions: "SELECT count(*) FROM permissions",
  plans: "SELECT count(*) FROM plans",
  subscriptions: "SELECT count(*) FROM subscriptions",
  invitations: "SELECT count(*) FROM invitations",
  tax_categories: "SELECT count(*) FROM tax_categories",
  tax_rates: "SELECT count(*) FROM tax_rates",
  categories: "SELECT count(*) FROM categories",
  brands: "SELECT count(*) FROM brands",
  units: "SELECT count(*) FROM units",
  products: "SELECT count(*) FROM products",
  product_variants: "SELECT count(*) FROM product_variants",
  barcodes: "SELECT count(*) FROM barcodes",
};

describe("auth_service cannot reach business data", () => {
  it.each(BUSINESS_TABLES)("reading %s is refused", async (table) => {
    expect(await failure(auth.query(SELECT_SQL[table] ?? ""))).toContain(`permission denied for table ${table}`);
  });

  it("writing a branch is refused", async () => {
    expect(
      await failure(auth.query("INSERT INTO branches (tenant_id, name) VALUES ($1, 'x')", [biz.ctx.tenantId])),
    ).toContain("permission denied for table branches");
  });
});

describe("auth_service can do its job on the login tables", () => {
  it("finds a user by email and their password record", async () => {
    const user = await auth.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1)", [
      `${biz.ctx.userId}@test.invalid`,
    ]);
    expect(user.rows).toEqual([{ id: biz.ctx.userId }]);
    const account = await auth.query("SELECT 1 FROM accounts WHERE user_id = $1 AND provider_id = 'credential'", [
      biz.ctx.userId,
    ]);
    expect(account.rowCount).toBe(1);
  });

  it("finds and revokes a session by its token", async () => {
    const token = `test-session-${randomUUID()}`;
    await auth.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')", [
      token,
      biz.ctx.userId,
    ]);
    expect((await auth.query("DELETE FROM sessions WHERE token = $1", [token])).rowCount).toBe(1);
  });

  it("can add to and read the security log, but never change or delete it", async () => {
    expect(await failure(auth.query("SELECT count(*) FROM security_events"))).toBe("no error");
    expect(await failure(auth.query("UPDATE security_events SET event = 'x.y'"))).toContain("permission denied");
    expect(await failure(auth.query("DELETE FROM security_events"))).toContain("permission denied");
  });
});

describe("app_user can never see login secrets", () => {
  it.each(LOGIN_SECRET_TABLES)("reading %s is refused, even inside a business", async (table) => {
    expect(await failure(withTenant(biz.ctx, (tx) => tx.execute(sql`SELECT count(*) FROM ${sql.identifier(table)}`)))).toContain(
      `permission denied for table ${table}`,
    );
  });

  it("cannot create user accounts (only the login library can)", async () => {
    const id = randomUUID();
    expect(
      await failure(
        withTenant(biz.ctx, (tx) =>
          tx.execute(sql`INSERT INTO users (id, email, display_name) VALUES (${id}, ${`${id}@test.invalid`}, 'x')`),
        ),
      ),
    ).toContain("permission denied for table users");
  });

  it("still sees its own colleagues' names (unchanged)", async () => {
    const result = await withTenant(biz.ctx, (tx) => tx.execute(sql`SELECT id FROM users`));
    expect(result.rows).toEqual([{ id: biz.ctx.userId }]);
  });
});
