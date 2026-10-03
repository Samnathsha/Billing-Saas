import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { SeriesFullError, takeNextNumber } from "@/modules/sales";
import { createTestBusiness } from "../helpers/business";

// Bill numbers (business rules 5.3, 12): in order, no gaps after a failed
// sale, no duplicates between tills, separate per business, series and year.

afterAll(async () => {
  await getDb().$client.end();
});

const INV = { kind: "invoice" as const, prefix: "INV", financialYear: "26-27" };

describe("taking bill numbers", () => {
  it("counts 1, 2, 3 and formats them", async () => {
    const { ctx } = await createTestBusiness("Numbers order");
    const taken = [];
    for (let i = 0; i < 3; i += 1) taken.push(await withTenant(ctx, (tx) => takeNextNumber(tx, ctx, INV)));
    expect(taken).toEqual([
      { number: 1, formatted: "INV/26-27/00001" },
      { number: 2, formatted: "INV/26-27/00002" },
      { number: 3, formatted: "INV/26-27/00003" },
    ]);
  });

  it("a sale that fails gives its number back: no gaps", async () => {
    const { ctx } = await createTestBusiness("Numbers rollback");
    await withTenant(ctx, (tx) => takeNextNumber(tx, ctx, INV));
    await expect(
      withTenant(ctx, async (tx) => {
        await takeNextNumber(tx, ctx, INV);
        throw new Error("the sale failed after taking a number");
      }),
    ).rejects.toThrow("the sale failed");
    expect(await withTenant(ctx, (tx) => takeNextNumber(tx, ctx, INV))).toMatchObject({ number: 2 });
  });

  it("20 tills at once get 20 different numbers with no gaps", async () => {
    const { ctx } = await createTestBusiness("Numbers race");
    const numbers = await Promise.all(Array.from({ length: 20 }, () => withTenant(ctx, (tx) => takeNextNumber(tx, ctx, INV)).then((r) => r.number)));
    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  }, 90_000);

  it("each business, series, prefix and year counts on its own", async () => {
    const a = await createTestBusiness("Numbers A");
    const b = await createTestBusiness("Numbers B");
    await withTenant(a.ctx, (tx) => takeNextNumber(tx, a.ctx, INV));
    await withTenant(a.ctx, (tx) => takeNextNumber(tx, a.ctx, INV));
    expect((await withTenant(b.ctx, (tx) => takeNextNumber(tx, b.ctx, INV))).number).toBe(1);
    expect((await withTenant(a.ctx, (tx) => takeNextNumber(tx, a.ctx, { ...INV, kind: "credit_note", prefix: "CN" }))).formatted).toBe("CN/26-27/00001");
    expect((await withTenant(a.ctx, (tx) => takeNextNumber(tx, a.ctx, { ...INV, financialYear: "27-28" }))).formatted).toBe("INV/27-28/00001");
    expect((await withTenant(a.ctx, (tx) => takeNextNumber(tx, a.ctx, { ...INV, prefix: "SHP" }))).formatted).toBe("SHP/26-27/00001");
  });

  it("stops at 99,999 instead of wrapping or growing past 16 characters", async () => {
    const { ctx } = await createTestBusiness("Numbers full");
    await withTenant(ctx, (tx) => takeNextNumber(tx, ctx, INV));
    await withTenant(ctx, (tx) => tx.execute(sql`UPDATE invoice_sequences SET last_number = 99998`));
    expect((await withTenant(ctx, (tx) => takeNextNumber(tx, ctx, INV))).formatted).toBe("INV/26-27/99999");
    await expect(withTenant(ctx, (tx) => takeNextNumber(tx, ctx, INV))).rejects.toBeInstanceOf(SeriesFullError);
  });

  it("another business cannot see or move this business's counter", async () => {
    const a = await createTestBusiness("Numbers own");
    const b = await createTestBusiness("Numbers other");
    await withTenant(a.ctx, (tx) => takeNextNumber(tx, a.ctx, { ...INV, prefix: "OWN" }));
    const seen = await withTenant(b.ctx, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM invoice_sequences WHERE prefix = 'OWN'`));
    expect(seen.rows[0]).toEqual({ n: 0 });
    const moved = await withTenant(b.ctx, (tx) => tx.execute(sql`UPDATE invoice_sequences SET last_number = 1 WHERE prefix = 'OWN'`));
    expect(moved.rowCount).toBe(0);
    expect((await withTenant(a.ctx, (tx) => takeNextNumber(tx, a.ctx, { ...INV, prefix: "OWN" }))).number).toBe(2);
  });
});
