import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { memberships, roles, tenants } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { BusinessDataError, cancelBusinessDeletion, exportBusinessData, getBusinessDeletion, requestBusinessDeletion } from "@/modules/tenants";
import { EXPORT_TABLES, NOT_EXPORTED } from "@/modules/tenants/repo";
import { purgeBusiness, PurgeRefused } from "../../scripts/lib/purge-business";
import { registerVerifiedUser } from "../helpers/auth";
import { createFullTestBusiness } from "../helpers/business";

// The owner's own data (Phase 11; ASVS 8.3.2): export everything, ask for
// deletion with a 30-day grace period, and the operator's purge.

const migrator = async (): Promise<pg.Client> => {
  const url = process.env.MIGRATOR_DATABASE_URL_TEST;
  if (url === undefined) throw new Error("MIGRATOR_DATABASE_URL_TEST is needed for the purge tests");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
};

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function ownerShop(label: string): Promise<{ ctx: TenantContext; name: string }> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  const name = `${label} Shop`;
  await createBusiness(owner.headers, { businessName: name, template: "clothing" });
  const r = await getRequestContext(owner.headers);
  if (r.kind !== "member") throw new Error("member");
  return { ctx: r.ctx, name };
}

async function member(owner: TenantContext, role: string) {
  const user = await registerVerifiedUser(`Data ${role}`);
  await withTenant(owner, async (tx) => {
    const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
    await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
  });
  const result = await getRequestContext(user.headers);
  if (result.kind !== "member") throw new Error("member");
  return { ctx: result.ctx, headers: user.headers };
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof BusinessDataError || error instanceof PermissionDeniedError || error instanceof PurgeRefused) return error instanceof PurgeRefused ? "REFUSED" : error.code;
    throw error;
  }
}

// Due date in the past, as if 30 days went by.
const pastDue = (ctx: TenantContext) =>
  withTenant(ctx, (tx) => tx.update(tenants).set({ deletionRequestedAt: new Date(Date.now() - 31 * 86_400_000), deletionRequestedBy: ctx.userId, deletionDueAt: new Date(Date.now() - 86_400_000) }).where(eq(tenants.id, ctx.tenantId)));

describe("export", () => {
  it("the owner gets every table of the business, only its own rows, never secrets; audited; not twice in 10 minutes", async () => {
    const a = await ownerShop("Export A");
    const b = await ownerShop("Export B");
    const data = await exportBusinessData(a.ctx);
    expect([...data.files.keys()].sort()).toEqual(["business.csv", "people.csv", ...EXPORT_TABLES.map((t) => `${t}.csv`)].sort());
    expect(data.files.get("business.csv")?.[1]).toContain("Export A Shop");
    const all = JSON.stringify([...data.files.values()]);
    expect(all).not.toContain(b.ctx.tenantId);
    expect(all).not.toContain("token_hash");
    expect(data.files.get("people.csv")?.length).toBe(2);
    expect(await codeOf(exportBusinessData(a.ctx))).toBe("EXPORT_TOO_SOON");
    const audit = await withTenant(a.ctx, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'business.exported'`));
    expect(audit.rows[0]).toEqual({ n: 1 });
  });

  it("only the owner may export", async () => {
    const a = await ownerShop("Export rights");
    const admin = await member(a.ctx, "Admin");
    expect(await codeOf(exportBusinessData(admin.ctx))).toBe("FORBIDDEN");
  });

  it("the table list is every table with business data (checked against the database)", async () => {
    const client = await migrator();
    try {
      const r = await client.query<{ name: string }>(
        "SELECT table_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY table_name",
      );
      expect([...EXPORT_TABLES, ...NOT_EXPORTED].sort()).toEqual(r.rows.map((x) => x.name));
    } finally {
      await client.end();
    }
  });
});

describe("deletion request", () => {
  it("the owner confirms with the exact name; 30 days' grace; everyone sees the date; it can be cancelled", async () => {
    const a = await ownerShop("Delete me");
    const cashier = await member(a.ctx, "Cashier");
    expect(await codeOf(requestBusinessDeletion(cashier.ctx, { confirmName: a.name }))).toBe("FORBIDDEN");
    expect(await codeOf(requestBusinessDeletion(a.ctx, { confirmName: "delete me shop" }))).toBe("NAME_MISMATCH");
    const asked = await requestBusinessDeletion(a.ctx, { confirmName: a.name });
    const days = (Date.parse(asked.dueAt ?? "") - Date.parse(asked.requestedAt ?? "")) / 86_400_000;
    expect(days).toBe(30);
    expect(await codeOf(requestBusinessDeletion(a.ctx, { confirmName: a.name }))).toBe("ALREADY_REQUESTED");
    expect((await getBusinessDeletion(cashier.ctx)).dueAt).toBe(asked.dueAt);
    // Still fully usable during the grace period.
    expect((await getRequestContext(cashier.headers)).kind).toBe("member");
    await cancelBusinessDeletion(a.ctx);
    expect(await getBusinessDeletion(a.ctx)).toEqual({ requestedAt: null, dueAt: null });
    expect(await codeOf(cancelBusinessDeletion(a.ctx))).toBe("NOT_REQUESTED");
  });

  it("after the date nobody can enter the business any more", async () => {
    const a = await ownerShop("Past due");
    const cashier = await member(a.ctx, "Cashier");
    await requestBusinessDeletion(a.ctx, { confirmName: a.name });
    await pastDue(a.ctx);
    expect((await getRequestContext(cashier.headers)).kind).not.toBe("member");
    expect(await codeOf(getBusinessDeletion(a.ctx))).toBe("FORBIDDEN");
  });
});

describe("the operator's purge", () => {
  it("refuses a business that did not ask, or before its date, or as another role", async () => {
    const a = await createFullTestBusiness("Purge refused");
    const client = await migrator();
    try {
      expect(await codeOf(purgeBusiness(client, a.ctx.tenantId, { confirmName: null }))).toBe("REFUSED");
      await withTenant(a.ctx, (tx) => tx.update(tenants).set({ deletionRequestedAt: new Date(), deletionRequestedBy: a.ctx.userId, deletionDueAt: new Date(Date.now() + 86_400_000) }).where(eq(tenants.id, a.ctx.tenantId)));
      expect(await codeOf(purgeBusiness(client, a.ctx.tenantId, { confirmName: null }))).toBe("REFUSED");
    } finally {
      await client.end();
    }
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL_TEST });
    await app.connect();
    try {
      expect(await codeOf(purgeBusiness(app, a.ctx.tenantId, { confirmName: null }))).toBe("REFUSED");
    } finally {
      await app.end();
    }
  });

  it("removes every row of that business (all tables, ledgers and logs included) and nothing of another; protections come back", async () => {
    const a = await createFullTestBusiness("Purge A");
    const b = await createFullTestBusiness("Purge B");
    await pastDue(a.ctx);
    const countB = async () => withTenant(b.ctx, (tx) => tx.execute(sql`SELECT (SELECT count(*) FROM invoices)::int AS invoices, (SELECT count(*) FROM audit_logs)::int AS audit, (SELECT count(*) FROM stock_movements)::int AS moves`));
    const before = (await countB()).rows[0];
    const client = await migrator();
    const links = async () => (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace")).rows[0]?.n;
    try {
      const linksBefore = await links();
      const dry = await purgeBusiness(client, a.ctx.tenantId, { confirmName: null });
      expect(dry.deleted).toBe(false);
      expect(dry.rows.invoices).toBe(1);
      expect(dry.rows.audit_logs).toBeGreaterThan(0);
      expect(Object.values(dry.rows).filter((n) => n > 0).length).toBeGreaterThan(30);
      expect(await codeOf(purgeBusiness(client, a.ctx.tenantId, { confirmName: "Wrong name" }))).toBe("REFUSED");

      const done = await purgeBusiness(client, a.ctx.tenantId, { confirmName: dry.businessName });
      expect(done.deleted).toBe(true);
      // The business row is gone, so no row of it is left anywhere: every
      // table's tenant_id points at tenants and would have stopped this.
      expect(await codeOf(purgeBusiness(client, a.ctx.tenantId, { confirmName: null }))).toBe("REFUSED");

      const weak = await client.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
            AND (NOT c.relforcerowsecurity OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal AND t.tgenabled = 'D'))`,
      );
      expect(weak.rows).toEqual([]);
      expect(await links()).toBe(linksBefore);
    } finally {
      await client.end();
    }
    expect((await countB()).rows[0]).toEqual(before);
    // The ledgers are still append-only for the app.
    await expect(withTenant(b.ctx, (tx) => tx.execute(sql`DELETE FROM audit_logs`))).rejects.toThrow();
  });
});
