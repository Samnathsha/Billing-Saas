import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { branches, tenants, users } from "@/db/schema";
import { createTenantContext, withTenant, type TenantContext } from "@/db/with-tenant";

// Runs against the real test database as app_user. Each run creates two new
// businesses with random ids, so runs never depend on earlier data.

async function createBusiness(name: string): Promise<{ ctx: TenantContext; branchId: string }> {
  const ctx = createTenantContext({ tenantId: randomUUID(), userId: randomUUID() });
  const branchId = randomUUID();
  await withTenant(ctx, async (tx) => {
    await tx.insert(users).values({ id: ctx.userId, email: `${ctx.userId}@test.invalid`, displayName: name });
    await tx.insert(tenants).values({ id: ctx.tenantId, name, template: "clothing" });
    await tx.insert(branches).values({ id: branchId, tenantId: ctx.tenantId, name: `${name} main` });
  });
  return { ctx, branchId };
}

let a: Awaited<ReturnType<typeof createBusiness>>;
let b: Awaited<ReturnType<typeof createBusiness>>;

beforeAll(async () => {
  a = await createBusiness("Test shop A");
  b = await createBusiness("Test shop B");
});

afterAll(async () => {
  await getDb().$client.end();
});

describe("withTenant", () => {
  it("sees only its own business's rows", async () => {
    const rows = await withTenant(a.ctx, (tx) => tx.select({ id: branches.id, tenantId: branches.tenantId }).from(branches));
    expect(rows).toEqual([{ id: a.branchId, tenantId: a.ctx.tenantId }]);
  });

  it("cannot read the other business's row even by its id", async () => {
    const rows = await withTenant(a.ctx, (tx) => tx.select().from(branches).where(eq(branches.id, b.branchId)));
    expect(rows).toEqual([]);
  });

  it("cannot write a row for the other business", async () => {
    await expect(
      withTenant(a.ctx, (tx) => tx.insert(branches).values({ tenantId: b.ctx.tenantId, name: "forged" })),
    ).rejects.toThrow();
  });

  it("rolls everything back when the work fails", async () => {
    const name = `rollback-${randomUUID()}`;
    await expect(
      withTenant(a.ctx, async (tx) => {
        await tx.insert(branches).values({ tenantId: a.ctx.tenantId, name });
        throw new Error("simulated failure");
      }),
    ).rejects.toThrow("simulated failure");
    const rows = await withTenant(a.ctx, (tx) => tx.select().from(branches).where(eq(branches.name, name)));
    expect(rows).toEqual([]);
  });

  it("outside withTenant, a query sees no business data", async () => {
    const db = getDb();
    expect(await db.select().from(branches)).toEqual([]);
    expect(await db.select().from(tenants)).toEqual([]);
    expect(await db.select().from(users)).toEqual([]);
  });

  it("the tenant setting does not survive the transaction (pooled connections stay clean)", async () => {
    await withTenant(a.ctx, async () => Promise.resolve());
    const result = await getDb().$client.query<{ tenant: string | null; user: string | null }>(
      "SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant, nullif(current_setting('app.user_id', true), '') AS user",
    );
    expect(result.rows[0]).toEqual({ tenant: null, user: null });
  });

  it("many parallel requests for two businesses never mix", async () => {
    const runs = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b));
    const results = await Promise.all(
      runs.map((biz) =>
        withTenant(biz.ctx, async (tx) => {
          const rows = await tx.select({ tenantId: branches.tenantId }).from(branches);
          return { expected: biz.ctx.tenantId, seen: rows.map((r) => r.tenantId) };
        }),
      ),
    );
    for (const { expected, seen } of results) expect(seen).toEqual([expected]);
  });
});

describe("TenantContext", () => {
  it("rejects anything that is not a UUID", () => {
    expect(() => createTenantContext({ tenantId: "1 OR 1=1", userId: randomUUID() })).toThrow();
    expect(() => createTenantContext({ tenantId: randomUUID(), userId: "" })).toThrow();
  });

  it("rejects extra fields", () => {
    const input = { tenantId: randomUUID(), userId: randomUUID(), role: "owner" };
    expect(() => createTenantContext(input)).toThrow();
  });

  it("withTenant re-checks a forged context that bypassed the type system", async () => {
    const forged = { tenantId: "' OR true --", userId: randomUUID() } as unknown as TenantContext;
    await expect(withTenant(forged, async () => Promise.resolve("ran"))).rejects.toThrow();
  });
});
