import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { settings } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { createProduct, getCatalogLists } from "@/modules/catalog";
import { getStockLevels, InventoryError, recordOpeningStock, StockError } from "@/modules/inventory";
import { createCustomer, getCustomer, PartyError } from "@/modules/parties";
import { createExchange, createSale, getCreditNote, getInvoice, getReturnable, listInvoices, SalesError, voidInvoice } from "@/modules/sales";
import { gstinCheckChar } from "@/modules/tax/gst";
import { listBranches } from "@/modules/tenants";
import { registerVerifiedUser } from "../helpers/auth";

// Exchanges (business rules 16): a return and a new sale in one
// transaction; the returned value pays first; the difference is paid or
// given back; all or nothing; an exchange bill cannot be voided.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

const GSTIN = (() => {
  const first14 = "33ABCDE1234F1Z";
  return first14 + gstinCheckChar(first14);
})();

async function newShop(label: string): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template: "clothing" });
  const r = await getRequestContext(owner.headers);
  if (r.kind !== "member") throw new Error("expected a member");
  await withTenant(r.ctx, (tx) => tx.update(settings).set({ gstRegistration: "registered", gstin: GSTIN, stateCode: "33" }));
  return r.ctx;
}

async function item(ctx: TenantContext, price: number, stock: string): Promise<string> {
  const lists = await getCatalogLists(ctx);
  const product = await createProduct(ctx, {
    name: `Shirt ${randomUUID().slice(0, 6)}`,
    unitId: lists.units.find((u) => u.code === "pcs")?.id ?? "",
    taxCategory: "test_5",
    variants: [{ sku: `S-${randomUUID().slice(0, 8)}`, sellingPricePaise: price, costPricePaise: 40_000 }],
  });
  const variantId = product.variants[0]?.id ?? "";
  if (stock !== "0") {
    const branchId = (await listBranches(ctx))[0]?.id ?? "";
    await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId, quantity: stock }] });
  }
  return variantId;
}

async function setup(label: string) {
  const ctx = await newShop(label);
  const branchId = (await listBranches(ctx))[0]?.id ?? "";
  const m = await item(ctx, 79_900, "5"); // ₹799
  const l = await item(ctx, 79_900, "5"); // ₹799, another size
  const jacket = await item(ctx, 129_900, "5"); // ₹1,299
  return { ctx, branchId, m, l, jacket };
}

async function bought(ctx: TenantContext, branchId: string, variantId: string, quantity: string, extra: Record<string, unknown> = {}) {
  const { invoiceId } = await createSale(ctx, { idempotencyKey: randomUUID(), invoiceId: randomUUID(), branchId, lines: [{ variantId, quantity }], ...extra });
  const lineId = (await getReturnable(ctx, { invoiceId })).lines[0]?.invoiceItemId ?? "";
  return { invoiceId, lineId };
}

const exchange = (
  branchId: string,
  original: { invoiceId: string; lineId: string },
  returnQuantity: string,
  saleLines: { variantId: string; quantity?: string }[],
  extra: { payments?: unknown[]; leftoverMethod?: string; customerId?: string | null } = {},
) => ({
  idempotencyKey: randomUUID(),
  branchId,
  return: { creditNoteId: randomUUID(), invoiceId: original.invoiceId, reason: "Wrong size", lines: [{ invoiceItemId: original.lineId, quantity: returnQuantity, resellable: true }] },
  sale: { invoiceId: randomUUID(), lines: saleLines.map((l) => ({ quantity: "1", ...l })), payments: extra.payments ?? [], customerId: extra.customerId ?? null },
  ...(extra.leftoverMethod === undefined ? {} : { leftoverMethod: extra.leftoverMethod }),
});

const level = async (ctx: TenantContext, variantId: string) => (await getStockLevels(ctx, { variantIds: [variantId] }))[0]?.quantity ?? "0.000";

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof SalesError || error instanceof StockError || error instanceof InventoryError || error instanceof PartyError || error instanceof PermissionDeniedError) return error.code;
    if (error instanceof ZodError) return `INVALID:${error.issues.map((i) => i.path.join(".")).join(",")}`;
    throw error;
  }
}

describe("exchanges", () => {
  it("same price, another size: no money changes hands; stock both ways; the new bill names the credit note; a retry saves once", async () => {
    const { ctx, branchId, m, l } = await setup("Exchange swap");
    const original = await bought(ctx, branchId, m, "1", { payments: [{ method: "cash", amountPaise: 79_900 }] });
    const input = exchange(branchId, original, "1", [{ variantId: l }]);
    const result = await createExchange(ctx, input);
    expect(await createExchange(ctx, input)).toEqual(result);
    const note = await getCreditNote(ctx, { creditNoteId: result.creditNoteId });
    const bill = await getInvoice(ctx, { invoiceId: result.invoiceId });
    expect(note).toMatchObject({ refundPaise: 79_900, refundMethod: "exchange", exchange: { invoiceId: result.invoiceId, paise: 79_900 } });
    expect(bill).toMatchObject({ payablePaise: 79_900, paidPaise: 79_900, creditPaise: 0 });
    expect(bill.payments).toEqual([{ method: "exchange", amountPaise: 79_900, reference: note.number, kind: "sale" }]);
    expect(await level(ctx, m)).toBe("5.000");
    expect(await level(ctx, l)).toBe("4.000");
    expect((await listInvoices(ctx)).map((b) => b.number.slice(-5)).sort()).toEqual(["00001", "00002"]);
  });

  it("a dearer item: the customer pays the difference", async () => {
    const { ctx, branchId, m, jacket } = await setup("Exchange dearer");
    const original = await bought(ctx, branchId, m, "1", { payments: [{ method: "cash", amountPaise: 79_900 }] });
    const result = await createExchange(ctx, exchange(branchId, original, "1", [{ variantId: jacket }], { payments: [{ method: "upi", amountPaise: 50_000 }] }));
    const bill = await getInvoice(ctx, { invoiceId: result.invoiceId });
    expect(bill).toMatchObject({ payablePaise: 129_900, paidPaise: 129_900 });
    expect(bill.payments.map((p) => [p.method, p.amountPaise])).toEqual([["exchange", 79_900], ["upi", 50_000]]);
    expect(await codeOf(createExchange(ctx, exchange(branchId, await bought(ctx, branchId, m, "1", { payments: [{ method: "cash", amountPaise: 79_900 }] }), "1", [{ variantId: jacket }])))).toBe("CREDIT_NEEDS_CUSTOMER");
  });

  it("a cheaper exchange: the leftover goes back as cash, or as store credit for a customer", async () => {
    const { ctx, branchId, m, l } = await setup("Exchange cheaper");
    const original = await bought(ctx, branchId, m, "2", { payments: [{ method: "cash", amountPaise: 159_800 }] });
    const cash = await createExchange(ctx, exchange(branchId, original, "2", [{ variantId: l }]));
    expect(await getCreditNote(ctx, { creditNoteId: cash.creditNoteId })).toMatchObject({ refundPaise: 159_800, refundMethod: "cash", exchange: { paise: 79_900 } });

    const { id: customerId } = await createCustomer(ctx, { name: "Swapper", phone: "", gstin: "", stateCode: "", creditLimitPaise: 0 });
    const theirs = await bought(ctx, branchId, m, "2", { customerId, payments: [{ method: "cash", amountPaise: 159_800 }] });
    const credit = await createExchange(ctx, exchange(branchId, theirs, "2", [{ variantId: l }], { leftoverMethod: "store_credit" }));
    expect(await getCreditNote(ctx, { creditNoteId: credit.creditNoteId })).toMatchObject({ refundMethod: "store_credit", exchange: { paise: 79_900 } });
    expect((await getInvoice(ctx, { invoiceId: credit.invoiceId })).buyer.customerId).toBe(customerId);
    expect((await getCustomer(ctx, { id: customerId })).balancePaise).toBe(-79_900);
  });

  it("all or nothing: if the new sale fails, the return is not saved either, and no number is used", async () => {
    const { ctx, branchId, m } = await setup("Exchange rollback");
    const empty = await item(ctx, 79_900, "0");
    const original = await bought(ctx, branchId, m, "1", { payments: [{ method: "cash", amountPaise: 79_900 }] });
    expect(await codeOf(createExchange(ctx, exchange(branchId, original, "1", [{ variantId: empty }])))).toBe("INSUFFICIENT_STOCK");
    expect((await getReturnable(ctx, { invoiceId: original.invoiceId })).lines[0]?.remaining).toBe("1.000");
    expect((await getReturnable(ctx, { invoiceId: original.invoiceId })).creditNotes).toEqual([]);
    expect(await level(ctx, m)).toBe("4.000");
    expect(await listInvoices(ctx)).toHaveLength(1);
    const ok = await createExchange(ctx, exchange(branchId, original, "1", [{ variantId: m }]));
    expect((await getCreditNote(ctx, { creditNoteId: ok.creditNoteId })).number).toMatch(/\/00001$/);
    expect((await getInvoice(ctx, { invoiceId: ok.invoiceId })).number).toMatch(/\/00002$/);
  });

  it("an exchange bill cannot be voided; the original then has a return and cannot be voided either", async () => {
    const { ctx, branchId, m, l } = await setup("Exchange void");
    const original = await bought(ctx, branchId, m, "1", { payments: [{ method: "cash", amountPaise: 79_900 }] });
    const result = await createExchange(ctx, exchange(branchId, original, "1", [{ variantId: l }]));
    expect(await codeOf(voidInvoice(ctx, { idempotencyKey: randomUUID(), invoiceId: result.invoiceId, reason: "Try" }))).toBe("EXCHANGE_BILL");
    expect(await codeOf(voidInvoice(ctx, { idempotencyKey: randomUUID(), invoiceId: original.invoiceId, reason: "Try" }))).toBe("RETURNS_EXIST");
  });
});
