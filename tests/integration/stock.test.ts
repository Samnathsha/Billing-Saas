import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auditLogs, memberships, roles, serialNumbers, stockMovements } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { createProduct, getCatalogLists } from "@/modules/catalog";
import { adjustStock, getStockLevels, InventoryError, postMovements, recordOpeningStock, StockError } from "@/modules/inventory";
import { closeBranch, createBranch, listBranches } from "@/modules/tenants";
import { registerVerifiedUser } from "../helpers/auth";

// The stock ledger: opening stock, adjustments, weighted average cost,
// never below zero, whole units, IMEI one at a time, retries, append-only,
// 100 simultaneous takers of the last unit, other businesses.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function newShop(label: string, template: "clothing" | "mobile" = "clothing"): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template });
  const r = await getRequestContext(owner.headers);
  if (r.kind !== "member") throw new Error("expected a member");
  return r.ctx;
}

async function setup(ctx: TenantContext, opts: { unit?: "pcs" | "m"; trackSerial?: boolean; cost?: number } = {}) {
  const lists = await getCatalogLists(ctx);
  const unitId = lists.units.find((u) => u.code === (opts.unit ?? "pcs"))?.id ?? "";
  const product = await createProduct(ctx, {
    name: `Item ${randomUUID().slice(0, 6)}`,
    unitId,
    taxCategory: "test_5",
    trackSerial: opts.trackSerial ?? false,
    ...(lists.template === "mobile" ? { attributes: { model: "M1" } } : {}),
    variants: [{ sku: `S-${randomUUID().slice(0, 8)}`, sellingPricePaise: 10_000, costPricePaise: opts.cost ?? 450 }],
  });
  const branchId = (await listBranches(ctx))[0]?.id ?? "";
  return { variantId: product.variants[0]?.id ?? "", branchId, productId: product.id };
}

async function level(ctx: TenantContext, variantId: string) {
  const rows = await getStockLevels(ctx, { variantIds: [variantId] });
  return rows[0] ?? { quantity: "0.000", averageCostPaise: "0.0000" };
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof StockError || error instanceof InventoryError || error instanceof PermissionDeniedError) return error.code;
    if (error instanceof ZodError) return "INVALID_INPUT";
    throw error;
  }
}

const out = (branchId: string, variantId: string, quantity: string, reasonCode = "damaged") => ({
  idempotencyKey: randomUUID(),
  branchId,
  variantId,
  direction: "out",
  quantity,
  reasonCode,
});

describe("opening stock", () => {
  it("records quantity and cost (the starting cost by default), once; a retry changes nothing", async () => {
    const ctx = await newShop("Opening");
    const { variantId, branchId } = await setup(ctx, { cost: 450 });
    const key = randomUUID();
    const first = await recordOpeningStock(ctx, { idempotencyKey: key, branchId, lines: [{ variantId, quantity: "10" }] });
    const again = await recordOpeningStock(ctx, { idempotencyKey: key, branchId, lines: [{ variantId, quantity: "10" }] });
    expect(again).toEqual(first);
    expect(await level(ctx, variantId)).toMatchObject({ quantity: "10.000", averageCostPaise: "450.0000" });
    expect(await codeOf(recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId, quantity: "5" }] }))).toBe("ALREADY_HAS_STOCK_HISTORY");
    const audit = await withTenant(ctx, (tx) => tx.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.action, "stock.opening_recorded")));
    expect(audit).toHaveLength(1);
  });
});

describe("weighted average cost (rule 7.3), exact decimals", () => {
  it("2 at ₹10 + 1 at ₹20 = ₹13.3333 each; stock out keeps the average and records it", async () => {
    const ctx = await newShop("Average");
    const { variantId, branchId } = await setup(ctx);
    await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId, quantity: "2", unitCostPaise: 1000 }] });
    await withTenant(ctx, (tx) =>
      postMovements(tx, ctx, [{ branchId, variantId, type: "PURCHASE_IN", quantity: "1", unitCostPaise: "2000", sourceType: "test", sourceId: randomUUID(), sourceLineId: randomUUID() }]),
    );
    expect(await level(ctx, variantId)).toMatchObject({ quantity: "3.000", averageCostPaise: "1333.3333" });
    await adjustStock(ctx, out(branchId, variantId, "1"));
    expect(await level(ctx, variantId)).toMatchObject({ quantity: "2.000", averageCostPaise: "1333.3333" });
    const [last] = await withTenant(ctx, (tx) =>
      tx.select({ cost: stockMovements.unitCostPaise, type: stockMovements.movementType }).from(stockMovements).where(eq(stockMovements.movementType, "ADJUSTMENT_OUT")),
    );
    expect(last).toEqual({ cost: "1333.3333", type: "ADJUSTMENT_OUT" });
  });
});

describe("never below zero; whole units; reasons", () => {
  it("taking more than there is is refused and changes nothing", async () => {
    const ctx = await newShop("Negative");
    const { variantId, branchId } = await setup(ctx);
    await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId, quantity: "2" }] });
    expect(await codeOf(adjustStock(ctx, out(branchId, variantId, "3")))).toBe("INSUFFICIENT_STOCK");
    expect((await level(ctx, variantId)).quantity).toBe("2.000");
    const moves = await withTenant(ctx, (tx) => tx.select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.variantId, variantId)));
    expect(moves).toHaveLength(1);
  });

  it("pieces are whole; metres may be fractions", async () => {
    const ctx = await newShop("Units Stock");
    const pcs = await setup(ctx);
    expect(await codeOf(recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId: pcs.branchId, lines: [{ variantId: pcs.variantId, quantity: "1.5" }] }))).toBe("WHOLE_UNITS_ONLY");
    const cloth = await setup(ctx, { unit: "m" });
    await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId: cloth.branchId, lines: [{ variantId: cloth.variantId, quantity: "12.5" }] });
    await adjustStock(ctx, out(cloth.branchId, cloth.variantId, "2.25", "count_correction"));
    expect((await level(ctx, cloth.variantId)).quantity).toBe("10.250");
  });

  it("an adjustment needs a known reason and a quantity above zero", async () => {
    const ctx = await newShop("Reasons");
    const { variantId, branchId } = await setup(ctx);
    expect(await codeOf(adjustStock(ctx, { ...out(branchId, variantId, "1"), reasonCode: "because" }))).toBe("INVALID_INPUT");
    expect(await codeOf(adjustStock(ctx, out(branchId, variantId, "0")))).toBe("ZERO_QUANTITY");
  });

  it("no stock goes into a closed branch", async () => {
    const ctx = await newShop("Closed Stock");
    const { variantId } = await setup(ctx);
    const second = await createBranch(ctx, { name: "Second" });
    await closeBranch(ctx, { branchId: second.id });
    expect(await codeOf(recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId: second.id, lines: [{ variantId, quantity: "1" }] }))).toBe("BRANCH_CLOSED");
  });
});

describe("IMEI items move one unit at a time", () => {
  it("opening stock creates one serial per unit; out marks it scrapped; numbers are unique", async () => {
    const ctx = await newShop("IMEI", "mobile");
    const { variantId, branchId } = await setup(ctx, { trackSerial: true });
    expect(await codeOf(recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId, quantity: "2", serials: ["356938035643809"] }] }))).toBe("SERIAL_COUNT");
    expect(await codeOf(recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId, quantity: "1" }] }))).toBe("SERIAL_REQUIRED");
    await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId, quantity: "2", serials: ["356938035643809", "356938035643817"] }] });
    expect((await level(ctx, variantId)).quantity).toBe("2.000");
    await adjustStock(ctx, { ...out(branchId, variantId, "1", "lost"), serial: "356938035643809" });
    expect((await level(ctx, variantId)).quantity).toBe("1.000");
    expect(await codeOf(adjustStock(ctx, { ...out(branchId, variantId, "1", "lost"), serial: "356938035643809" }))).toBe("SERIAL_NOT_IN_STOCK");
    expect(await codeOf(adjustStock(ctx, { idempotencyKey: randomUUID(), branchId, variantId, direction: "in", quantity: "1", reasonCode: "found", serial: "356938035643817" }))).toBe("SERIAL_TAKEN");
    const statuses = await withTenant(ctx, (tx) => tx.select({ status: serialNumbers.status }).from(serialNumbers).orderBy(serialNumbers.serial));
    expect(statuses.map((s) => s.status)).toEqual(["scrapped", "in_stock"]);
  });
});

describe("the ledger", () => {
  it("cannot be changed or deleted, even directly", async () => {
    const ctx = await newShop("Ledger");
    const { variantId, branchId } = await setup(ctx);
    await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId, quantity: "1" }] });
    for (const statement of [sql`UPDATE stock_movements SET quantity = 100`, sql`DELETE FROM stock_movements`]) {
      const error: unknown = await withTenant(ctx, (tx) => tx.execute(statement)).catch((e: unknown) => e);
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
      expect(cause).toMatch(/append-only|permission denied/);
    }
  });

  it("the same source line cannot be posted twice", async () => {
    const ctx = await newShop("Twice");
    const { variantId, branchId } = await setup(ctx);
    const move = { branchId, variantId, type: "PURCHASE_IN" as const, quantity: "1", unitCostPaise: "100", sourceType: "test", sourceId: randomUUID(), sourceLineId: randomUUID() };
    await withTenant(ctx, (tx) => postMovements(tx, ctx, [move]));
    expect(await codeOf(withTenant(ctx, (tx) => postMovements(tx, ctx, [move])))).toBe("ALREADY_POSTED");
    expect((await level(ctx, variantId)).quantity).toBe("1.000");
  });
});

describe("100 people take the last unit at the same moment", () => {
  it("exactly one succeeds; stock ends at zero, never below", async () => {
    const ctx = await newShop("Last Unit");
    const { variantId, branchId } = await setup(ctx);
    await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId, quantity: "1" }] });
    const results = await Promise.all(Array.from({ length: 100 }, () => codeOf(adjustStock(ctx, out(branchId, variantId, "1")))));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "INSUFFICIENT_STOCK")).toHaveLength(99);
    expect((await level(ctx, variantId)).quantity).toBe("0.000");
  }, 120_000);
});

describe("who may change stock", () => {
  it("a cashier may not; cost is hidden from them", async () => {
    const owner = await newShop("Stock Cashier");
    const { variantId, branchId } = await setup(owner);
    await recordOpeningStock(owner, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId, quantity: "3" }] });
    const user = await registerVerifiedUser("Stock Cashier");
    await withTenant(owner, async (tx) => {
      const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, "Cashier"));
      await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
    });
    const cashier = await getRequestContext(user.headers);
    if (cashier.kind !== "member") throw new Error("member");
    expect(await codeOf(adjustStock(cashier.ctx, out(branchId, variantId, "1")))).toBe("FORBIDDEN");
    expect(await getStockLevels(cashier.ctx, { variantIds: [variantId] })).toEqual([{ variantId, branchId, quantity: "3.000" }]);
  });
});

describe("another business", () => {
  it("cannot move or see another business's stock", async () => {
    const a = await newShop("Stock A");
    const b = await newShop("Stock B");
    const bItem = await setup(b);
    await recordOpeningStock(b, { idempotencyKey: randomUUID(), branchId: bItem.branchId, lines: [{ variantId: bItem.variantId, quantity: "5" }] });
    const aBranch = (await listBranches(a))[0]?.id ?? "";
    expect(await codeOf(adjustStock(a, out(aBranch, bItem.variantId, "1")))).toBe("VARIANT_NOT_FOUND");
    expect(await getStockLevels(a, { variantIds: [bItem.variantId] })).toEqual([]);
    expect((await level(b, bItem.variantId)).quantity).toBe("5.000");
  });
});
