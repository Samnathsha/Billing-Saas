import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { settings } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext } from "@/modules/auth";
import { createProduct, getCatalogLists } from "@/modules/catalog";
import { adjustStock, recordOpeningStock } from "@/modules/inventory";
import { createSupplier } from "@/modules/parties";
import { createPurchase, voidPurchase } from "@/modules/purchasing";
import { createBranch, listBranches } from "@/modules/tenants";
import { checkTenantStock } from "../../scripts/lib/stock-check";
import { registerVerifiedUser } from "../helpers/auth";

// scripts/rebuild-stock.ts against real activity: replaying the ledger in
// the order it was applied gives exactly the stored balances, even after
// simultaneous saves; a tampered balance is reported; one business only.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function newShop(label: string): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template: "clothing" });
  const r = await getRequestContext(owner.headers);
  if (r.kind !== "member") throw new Error("expected a member");
  await withTenant(r.ctx, (tx) => tx.update(settings).set({ gstRegistration: "unregistered" }));
  return r.ctx;
}

async function item(ctx: TenantContext, unit: "pcs" | "m" = "pcs"): Promise<string> {
  const lists = await getCatalogLists(ctx);
  const product = await createProduct(ctx, {
    name: `Item ${randomUUID().slice(0, 6)}`,
    unitId: lists.units.find((u) => u.code === unit)?.id ?? "",
    taxCategory: "test_5",
    variants: [{ sku: `S-${randomUUID().slice(0, 8)}`, sellingPricePaise: 100_000, costPricePaise: 777 }],
  });
  return product.variants[0]?.id ?? "";
}

async function check(ctx: TenantContext) {
  const client = await getDb().$client.connect();
  try {
    return await checkTenantStock(client, ctx.tenantId);
  } finally {
    client.release();
  }
}

const buy = (supplierId: string, branchId: string, variantId: string, quantity: string, unitPricePaise: number, taxRate = "5") => ({
  idempotencyKey: randomUUID(),
  supplierId,
  branchId,
  supplierInvoiceNumber: `R-${randomUUID().slice(0, 8)}`,
  invoiceDate: "2026-09-01",
  lines: [{ variantId, quantity, unitPricePaise, taxRate }],
});

const out = (branchId: string, variantId: string, quantity: string) => ({
  idempotencyKey: randomUUID(),
  branchId,
  variantId,
  direction: "out",
  quantity,
  reasonCode: "damaged",
});

describe("rebuilding stock from its history", () => {
  it("matches the balances exactly after a busy mix, including 20 simultaneous saves on one item", async () => {
    const ctx = await newShop("Rebuild busy");
    const main = (await listBranches(ctx))[0]?.id ?? "";
    const { id: second } = await createBranch(ctx, { name: "Second branch" });
    const { id: supplierId } = await createSupplier(ctx, { name: "Rebuild Traders", phone: "", gstin: "", stateCode: "" });
    const shirt = await item(ctx);
    const cloth = await item(ctx, "m");

    await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId: main, lines: [{ variantId: shirt, quantity: "3" }, { variantId: cloth, quantity: "10.5", unitCostPaise: 3333 }] });
    await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId: second, lines: [{ variantId: shirt, quantity: "1", unitCostPaise: 999 }] });
    const wrong = await createPurchase(ctx, buy(supplierId, main, shirt, "7", 1234, "12"));
    await createPurchase(ctx, buy(supplierId, main, cloth, "0.125", 9999, "5"));
    await adjustStock(ctx, out(main, cloth, "2.375"));
    await adjustStock(ctx, { ...out(main, shirt, "1"), direction: "in", reasonCode: "found" });
    await voidPurchase(ctx, { idempotencyKey: randomUUID(), purchaseId: wrong.purchaseId, reason: "Wrong price" });

    // Saves racing on the same item: different costs coming in, stock going out.
    const work = Array.from({ length: 20 }, (_, i) =>
      i % 4 === 3 ? adjustStock(ctx, out(main, shirt, "1")).catch(() => undefined) : createPurchase(ctx, buy(supplierId, main, shirt, String(1 + (i % 3)), 1000 + i * 37, "18")),
    );
    await Promise.all(work);

    const result = await check(ctx);
    expect(result.differences).toEqual([]);
    expect(result.movements).toBeGreaterThan(20);
    expect(result.balances).toBe(3);
  }, 90_000);

  it("reports a balance that does not match its history", async () => {
    const ctx = await newShop("Rebuild tampered");
    const branchId = (await listBranches(ctx))[0]?.id ?? "";
    const shirt = await item(ctx);
    await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId: shirt, quantity: "5", unitCostPaise: 1000 }] });
    await withTenant(ctx, (tx) => tx.execute(sql`UPDATE stock_balances SET quantity = quantity + 1, average_cost_paise = 1000.0001`));
    expect((await check(ctx)).differences).toEqual([
      { variantId: shirt, branchId, problem: "quantity", expected: "5.000", found: "6.000" },
      { variantId: shirt, branchId, problem: "average_cost", expected: "1000.0000", found: "1000.0001" },
    ]);
  });

  it("sees only the business it is run for", async () => {
    const a = await newShop("Rebuild A");
    const b = await newShop("Rebuild B");
    const bBranch = (await listBranches(b))[0]?.id ?? "";
    await recordOpeningStock(b, { idempotencyKey: randomUUID(), branchId: bBranch, lines: [{ variantId: await item(b), quantity: "4" }] });
    expect(await check(a)).toEqual({ movements: 0, balances: 0, differences: [] });
    expect(await check(b)).toMatchObject({ movements: 1, balances: 1, differences: [] });
  });
});
