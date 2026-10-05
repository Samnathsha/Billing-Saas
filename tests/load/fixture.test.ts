import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { settings } from "@/db/schema";
import { withTenant } from "@/db/with-tenant";
import { makeOfflineSale } from "@/lib/offline-bill";
import { createBusiness, getRequestContext } from "@/modules/auth";
import { createProduct, getCatalogLists } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { getTillSnapshot } from "@/modules/sales";
import { registerTill } from "@/modules/sync";
import { listBranches } from "@/modules/tenants";
import { registerVerifiedUser, TEST_PASSWORD } from "../helpers/auth";

// Data for the k6 load test (Phase 11, docs/load-test.md): a GST shop with
// 40 items in big stock, 5 registered tills and 200 ready bills per till
// (made with the till's own code). Writes LOAD_FIXTURE (a local file: it
// holds the test owner's password and till tokens of the LOCAL database).
//   npm run load:fixture

const TILLS = 5;
const BILLS_PER_TILL = 200;
const ITEMS = 40;

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

describe("load test data", () => {
  it("is written", async () => {
    if (!(process.env.DATABASE_URL_TEST ?? "").includes("localhost")) throw new Error("Load test data only on the local database.");
    const file = process.env.LOAD_FIXTURE ?? ".load/fixture.json";
    const owner = await registerVerifiedUser("Load Owner");
    await createBusiness(owner.headers, { businessName: "Load Shop", template: "clothing" });
    const r = await getRequestContext(owner.headers);
    if (r.kind !== "member") throw new Error("member");
    const ctx = r.ctx;
    await withTenant(ctx, (tx) => tx.update(settings).set({ gstRegistration: "registered", gstin: "33ABCDE1234F1Z7", stateCode: "33" }));
    const lists = await getCatalogLists(ctx);
    const branchId = (await listBranches(ctx))[0]?.id ?? "";
    const variants: string[] = [];
    for (let i = 0; i < ITEMS; i += 1) {
      const p = await createProduct(ctx, {
        name: `Load Shirt ${String(i)}`,
        unitId: lists.units.find((u) => u.code === "pcs")?.id ?? "",
        taxCategory: "test_5",
        hsnCode: "6205",
        variants: [{ sku: `LOAD-${String(i)}-${randomUUID().slice(0, 4)}`, sellingPricePaise: 49_900 + i * 1_000, costPricePaise: 30_000 }],
      });
      variants.push(p.variants[0]?.id ?? "");
    }
    await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: variants.map((variantId) => ({ variantId, quantity: "100000" })) });

    const tills = [];
    for (let t = 0; t < TILLS; t += 1) {
      const till = await registerTill(ctx, { name: `Load ${String(t)}`, branchId, prefix: `L${String(t)}` });
      const snap = await getTillSnapshot(ctx, till.token);
      const ops = [];
      for (let b = 0; b < BILLS_PER_TILL; b += 1) {
        const lines = [0, 1, 2].map((k) => {
          const item = snap.items.find((i) => i.variantId === variants[(b + k * 7 + t) % ITEMS]);
          if (item === undefined) throw new Error("item");
          return { item, quantity: String(1 + (k % 2)), discountPaise: 0, serial: null };
        });
        const draft = makeOfflineSale({ opId: randomUUID(), invoiceId: randomUUID(), lineIds: lines.map(() => randomUUID()), madeBy: ctx.userId, at: new Date(), settings: snap.settings, taxRates: snap.taxRates, prefix: snap.till.prefix, sequence: b + 1, lines, billDiscountPaise: 0, payments: [] });
        ops.push({ ...draft.op, payments: [{ method: "cash", amountPaise: draft.bill.payablePaise, reference: null }] });
      }
      tills.push({ token: till.token, ops });
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ email: owner.email, password: TEST_PASSWORD, search: "Load Shirt", tills }), { mode: 0o600 });
    expect(tills).toHaveLength(TILLS);
  });
});
