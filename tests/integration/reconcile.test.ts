import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { settings } from "@/db/schema";
import { withTenant } from "@/db/with-tenant";
import { makeOfflineSale } from "@/lib/offline-bill";
import { createBusiness, getRequestContext } from "@/modules/auth";
import { createProduct, getCatalogLists } from "@/modules/catalog";
import { recordOpeningStock } from "@/modules/inventory";
import { createCustomer } from "@/modules/parties";
import { applyOfflineOperation, createReturn, createSale, getReturnable, getTillSnapshot, recordCustomerPayment, voidInvoice } from "@/modules/sales";
import { registerTill } from "@/modules/sync";
import { listBranches } from "@/modules/tenants";
import { reconcile } from "../../scripts/lib/reconcile-core";
import { registerVerifiedUser } from "../helpers/auth";

// The daily reconciliation (Phase 12): a real day of a shop adds up; a
// tampered stock figure is flagged.

const reader = async (): Promise<pg.Client> => {
  const url = process.env.BACKUP_DATABASE_URL_TEST;
  if (url === undefined) throw new Error("BACKUP_DATABASE_URL_TEST (backup_reader) is needed");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
};

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

describe("daily reconciliation", () => {
  it("a day of cash, credit, payment, return, void and an offline bill below zero stock adds up; a tampered stock figure is flagged", async () => {
    const owner = await registerVerifiedUser("Reconcile Owner");
    await createBusiness(owner.headers, { businessName: "Reconcile Shop", template: "clothing" });
    const r = await getRequestContext(owner.headers);
    if (r.kind !== "member") throw new Error("member");
    const ctx = r.ctx;
    await withTenant(ctx, (tx) => tx.update(settings).set({ gstRegistration: "registered", gstin: "33ABCDE1234F1Z7", stateCode: "33" }));
    const lists = await getCatalogLists(ctx);
    const branchId = (await listBranches(ctx))[0]?.id ?? "";
    const product = await createProduct(ctx, { name: "Reconcile Shirt", unitId: lists.units.find((u) => u.code === "pcs")?.id ?? "", taxCategory: "test_5", hsnCode: "6205", variants: [{ sku: `RC-${randomUUID().slice(0, 6)}`, sellingPricePaise: 79_900, costPricePaise: 45_000 }] });
    const variantId = product.variants[0]?.id ?? "";
    await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId, quantity: "4" }] });

    const sale = async (quantity: string, payments: { method: string; amountPaise: number }[], customerId: string | null = null) => {
      const invoiceId = randomUUID();
      await createSale(ctx, { idempotencyKey: randomUUID(), invoiceId, branchId, customerId, lines: [{ variantId, quantity }], payments });
      return invoiceId;
    };
    await sale("1", [{ method: "cash", amountPaise: 79_900 }]);
    const { id: customerId } = await createCustomer(ctx, { name: "Credit Customer", phone: "", gstin: "", stateCode: "", creditLimitPaise: 1_000_000 });
    await sale("1", [{ method: "upi", amountPaise: 29_900 }], customerId);
    await recordCustomerPayment(ctx, { idempotencyKey: randomUUID(), customerId, branchId, method: "cash", amountPaise: 50_000 });
    const returned = await sale("1", [{ method: "card", amountPaise: 79_900 }]);
    const line = (await getReturnable(ctx, { invoiceId: returned })).lines[0];
    if (line === undefined) throw new Error("line");
    await createReturn(ctx, { idempotencyKey: randomUUID(), creditNoteId: randomUUID(), invoiceId: returned, branchId, refundMethod: "cash", reason: "Wrong size", lines: [{ invoiceItemId: line.invoiceItemId, quantity: "1", resellable: true }] });
    const voided = await sale("1", [{ method: "cash", amountPaise: 79_900 }]);
    await voidInvoice(ctx, { idempotencyKey: randomUUID(), invoiceId: voided, reason: "Wrong item" });

    // Offline: two more shirts than are left (stock goes below zero).
    const till = await registerTill(ctx, { name: "R1", branchId, prefix: "R1" });
    const snap = await getTillSnapshot(ctx, till.token);
    const shirt = snap.items.find((i) => i.variantId === variantId);
    if (shirt === undefined) throw new Error("item");
    const draft = makeOfflineSale({ opId: randomUUID(), invoiceId: randomUUID(), lineIds: [randomUUID()], madeBy: ctx.userId, at: new Date(), settings: snap.settings, taxRates: snap.taxRates, prefix: "R1", sequence: 1, lines: [{ item: shirt, quantity: "3", discountPaise: 0, serial: null }], billDiscountPaise: 0, payments: [] });
    await applyOfflineOperation(ctx, till.token, { ...draft.op, payments: [{ method: "cash", amountPaise: draft.bill.payablePaise, reference: null }] });

    const client = await reader();
    try {
      const clean = await reconcile(client, today(), [ctx.tenantId]);
      expect(clean.mismatches).toEqual([]);
      expect(clean.summary).toEqual([{ tenantId: ctx.tenantId, business: "Reconcile Shop", bills: 4, salesPaise: 79_900 * 3 + 79_900 * 3, receivedPaise: 79_900 + 29_900 + 79_900 + 79_900 * 3, returnsPaise: 79_900 }]);
    } finally {
      await client.end();
    }

    // Tampering, as only the table owner could: one more shirt on the shelf.
    const owner2 = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL_TEST });
    await owner2.connect();
    try {
      await owner2.query("BEGIN");
      await owner2.query("ALTER TABLE stock_balances NO FORCE ROW LEVEL SECURITY");
      await owner2.query("UPDATE stock_balances SET quantity = quantity + 1 WHERE tenant_id = $1", [ctx.tenantId]);
      await owner2.query("ALTER TABLE stock_balances FORCE ROW LEVEL SECURITY");
      await owner2.query("COMMIT");
    } finally {
      await owner2.end();
    }
    const client2 = await reader();
    try {
      const tampered = await reconcile(client2, today(), [ctx.tenantId]);
      expect(tampered.mismatches.map((m) => m.check)).toEqual(["stock_balance_vs_movements"]);
      // 4 opening - 7 sold + 1 voided back + 1 returned = -1; tampered to 0.
      expect(tampered.mismatches[0]?.detail).toContain("expected -1.000, found 0.000");
    } finally {
      await client2.end();
    }
  });

  it("runs read-only: it can change nothing", async () => {
    const client = await reader();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await expect(client.query("UPDATE tenants SET name = name")).rejects.toThrow(/read-only/);
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  });
});
