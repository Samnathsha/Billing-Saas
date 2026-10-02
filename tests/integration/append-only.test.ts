import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { auditLogs, devices, syncOperations } from "@/db/schema";
import { withTenant } from "@/db/with-tenant";
import { createTestBusiness, type TestBusiness } from "../helpers/business";

// audit_logs and sync_operations can only grow: no UPDATE, DELETE or
// TRUNCATE for anyone, and created_at always comes from the database clock.

let biz: TestBusiness;
let auditId: string;
let deviceId: string;

beforeAll(async () => {
  biz = await createTestBusiness("Append-only shop");
  auditId = randomUUID();
  deviceId = randomUUID();
  await withTenant(biz.ctx, async (tx) => {
    await tx.insert(auditLogs).values({
      id: auditId,
      tenantId: biz.ctx.tenantId,
      actorUserId: biz.ctx.userId,
      action: "test.created",
      after: { note: "original" },
    });
    await tx.insert(devices).values({ id: deviceId, tenantId: biz.ctx.tenantId, branchId: biz.branchId, name: "Till 1" });
    await tx.insert(syncOperations).values({
      tenantId: biz.ctx.tenantId,
      deviceId,
      clientOpId: randomUUID(),
      operation: "sale.create",
      status: "applied",
    });
  });
});

afterAll(async () => {
  await getDb().$client.end();
});

// Postgres reports the real reason on the error's cause.
async function failureOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return cause instanceof Error ? cause.message : String(cause);
  }
  return "no error";
}

describe("audit_logs is append-only for the app", () => {
  it("allows adding and reading entries", async () => {
    const rows = await withTenant(biz.ctx, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.id, auditId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.after).toEqual({ note: "original" });
  });

  it("refuses to change an entry", async () => {
    const message = await failureOf(
      withTenant(biz.ctx, (tx) => tx.update(auditLogs).set({ action: "test.edited" }).where(eq(auditLogs.id, auditId))),
    );
    expect(message).toContain("permission denied for table audit_logs");
  });

  it("refuses to delete an entry", async () => {
    const message = await failureOf(withTenant(biz.ctx, (tx) => tx.delete(auditLogs).where(eq(auditLogs.id, auditId))));
    expect(message).toContain("permission denied for table audit_logs");
  });

  it("refuses to empty the table", async () => {
    const message = await failureOf(withTenant(biz.ctx, (tx) => tx.execute(sql`TRUNCATE audit_logs`)));
    expect(message).toContain("permission denied for table audit_logs");
  });

  it("ignores a backdated time and uses the database clock", async () => {
    const id = randomUUID();
    const before = Date.now();
    await withTenant(biz.ctx, (tx) =>
      tx.insert(auditLogs).values({
        id,
        tenantId: biz.ctx.tenantId,
        action: "test.backdated",
        occurredAt: new Date("2020-01-01T00:00:00Z"),
      }),
    );
    const [row] = await withTenant(biz.ctx, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.id, id)));
    expect(row?.occurredAt.getTime()).toBeGreaterThan(before - 60_000);
  });

  it("the entry is unchanged after all attempts", async () => {
    const [row] = await withTenant(biz.ctx, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.id, auditId)));
    expect(row?.action).toBe("test.created");
    expect(row?.after).toEqual({ note: "original" });
  });
});

describe("sync_operations is append-only for the app", () => {
  it("refuses to change or delete a recorded operation", async () => {
    const where = eq(syncOperations.deviceId, deviceId);
    expect(
      await failureOf(withTenant(biz.ctx, (tx) => tx.update(syncOperations).set({ status: "rejected" }).where(where))),
    ).toContain("permission denied for table sync_operations");
    expect(await failureOf(withTenant(biz.ctx, (tx) => tx.delete(syncOperations).where(where)))).toContain(
      "permission denied for table sync_operations",
    );
  });
});

// The table owner is blocked by the triggers too. (Forced RLS already hides
// every row from migrator; TRUNCATE ignores RLS, so the trigger is what
// stops it.)
const TRUNCATE_SQL = {
  audit_logs: "TRUNCATE audit_logs",
  sync_operations: "TRUNCATE sync_operations",
} as const;

describe("even the table owner (migrator) cannot erase history", () => {
  it.each(["audit_logs", "sync_operations"] as const)("TRUNCATE %s is refused", async (table) => {
    const url = process.env.MIGRATOR_DATABASE_URL_TEST;
    if (url === undefined || url === "") throw new Error("MIGRATOR_DATABASE_URL_TEST must be set for database tests");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const message = await failureOf(client.query(TRUNCATE_SQL[table]));
      expect(message).toContain(`${table} is append-only: TRUNCATE is not allowed`);
    } finally {
      await client.end();
    }
  });
});
