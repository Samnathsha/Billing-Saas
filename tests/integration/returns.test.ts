import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auditLogs, memberships, roles, serialNumbers, settings } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { createProduct, getCatalogLists } from "@/modules/catalog";
import { getStockLevels, InventoryError, recordOpeningStock, StockError } from "@/modules/inventory";
import { createCustomer, getCustomer, PartyError } from "@/modules/parties";
import { createReturn, createSale, getCreditNote, getInvoice, getReturnable, SalesError, voidInvoice } from "@/modules/sales";
import { gstinCheckChar } from "@/modules/tax/gst";
import { listBranches } from "@/modules/tenants";
import { registerVerifiedUser } from "../helpers/auth";

// Returns and credit notes (business rules 16): amounts reverse the bill
// exactly, never more than sold, the 7-day window, resellable or damaged,
// money back or store credit, IMEIs, one bill locked at a time, no void
// after a return, other businesses.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

const GSTIN = (() => {
  const first14 = "33ABCDE1234F1Z";
  return first14 + gstinCheckChar(first14);
})();

async function newShop(label: string, template: "clothing" | "mobile" = "clothing"): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template });
  const r = await getRequestContext(owner.headers);
  if (r.kind !== "member") throw new Error("expected a member");
  await withTenant(r.ctx, (tx) => tx.update(settings).set({ gstRegistration: "registered", gstin: GSTIN, stateCode: "33" }));
  return r.ctx;
}

async function memberWithRole(owner: TenantContext, role: string): Promise<TenantContext> {
  const user = await registerVerifiedUser(`Returns ${role}`);
  await withTenant(owner, async (tx) => {
    const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
    await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
  });
  const result = await getRequestContext(user.headers);
  if (result.kind !== "member") throw new Error("member");
  return result.ctx;
}

async function stocked(ctx: TenantContext, stock: string, opts: { price?: number; trackSerial?: boolean; serials?: string[] } = {}) {
  const lists = await getCatalogLists(ctx);
  const product = await createProduct(ctx, {
    name: `Item ${randomUUID().slice(0, 6)}`,
    unitId: lists.units.find((u) => u.code === "pcs")?.id ?? "",
    taxCategory: "test_5",
    trackSerial: opts.trackSerial ?? false,
    ...(lists.template === "mobile" ? { attributes: { model: "M1" } } : {}),
    variants: [{ sku: `S-${randomUUID().slice(0, 8)}`, sellingPricePaise: opts.price ?? 79_900, costPricePaise: 45_000 }],
  });
  const branchId = (await listBranches(ctx))[0]?.id ?? "";
  const variantId = product.variants[0]?.id ?? "";
  await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId, quantity: stock, serials: opts.serials ?? [] }] });
  return { variantId, branchId };
}

async function sold(ctx: TenantContext, branchId: string, lines: { variantId: string; quantity?: string; serial?: string }[], extra: Record<string, unknown> = {}) {
  const { invoiceId } = await createSale(ctx, {
    idempotencyKey: randomUUID(),
    invoiceId: randomUUID(),
    branchId,
    lines: lines.map((l) => ({ quantity: "1", ...l })),
    ...extra,
  });
  const bill = await getInvoice(ctx, { invoiceId });
  return { invoiceId, bill, itemIds: (await getReturnable(ctx, { invoiceId })).lines.map((l) => l.invoiceItemId) };
}

const back = (invoiceId: string, branchId: string, lines: { invoiceItemId: string; quantity: string; resellable?: boolean }[], extra: Record<string, unknown> = {}) => ({
  idempotencyKey: randomUUID(),
  creditNoteId: randomUUID(),
  invoiceId,
  branchId,
  refundMethod: "cash",
  reason: "Wrong size",
  lines: lines.map((l) => ({ resellable: true, ...l })),
  ...extra,
});

const level = async (ctx: TenantContext, variantId: string) => (await getStockLevels(ctx, { variantIds: [variantId] }))[0]?.quantity ?? "0.000";
const pay = (amountPaise: number) => ({ payments: [{ method: "cash", amountPaise }] });

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

describe("returning items", () => {
  it("a whole bill back for cash: the credit note mirrors the bill exactly; stock back at the bill's cost; numbered CN; audited", async () => {
    const ctx = await newShop("Return all");
    const { variantId, branchId } = await stocked(ctx, "5");
    const { invoiceId, bill, itemIds } = await sold(ctx, branchId, [{ variantId, quantity: "2" }], pay(159_800));
    const input = back(invoiceId, branchId, [{ invoiceItemId: itemIds[0] ?? "", quantity: "2" }]);
    const { creditNoteId } = await createReturn(ctx, input);
    expect(await createReturn(ctx, input)).toEqual({ creditNoteId });
    const note = await getCreditNote(ctx, { creditNoteId });
    expect(note.number).toMatch(/^CN\/\d{2}-\d{2}\/00001$/);
    expect(note).toMatchObject({
      invoice: { id: invoiceId, number: bill.number },
      taxablePaise: bill.taxablePaise,
      cgstPaise: bill.cgstPaise,
      sgstPaise: bill.sgstPaise,
      totalPaise: bill.totalPaise,
      refundPaise: bill.payablePaise,
      refundMethod: "cash",
      outsideWindow: false,
      seller: { gstin: GSTIN },
    });
    expect(note.items).toEqual([expect.objectContaining({ quantity: "2.000", resellable: true, totalPaise: 159_800, taxLabel: "TEST 5%" })]);
    expect(await level(ctx, variantId)).toBe("5.000");
    expect((await getReturnable(ctx, { invoiceId })).lines[0]).toMatchObject({ sold: "2.000", returned: "2.000", remaining: "0.000" });
    const audit = await withTenant(ctx, (tx) => tx.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, creditNoteId)));
    expect(audit).toEqual([{ action: "sales.return_created" }]);
  });

  it("two partial returns add up exactly to the line; a third is refused", async () => {
    const ctx = await newShop("Return parts");
    const { variantId, branchId } = await stocked(ctx, "5");
    const { invoiceId, bill, itemIds } = await sold(ctx, branchId, [{ variantId, quantity: "2" }], pay(159_800));
    const item = itemIds[0] ?? "";
    const one = await createReturn(ctx, back(invoiceId, branchId, [{ invoiceItemId: item, quantity: "1" }]));
    const two = await createReturn(ctx, back(invoiceId, branchId, [{ invoiceItemId: item, quantity: "1" }]));
    const [a, b] = [await getCreditNote(ctx, one), await getCreditNote(ctx, two)];
    expect(a.totalPaise + b.totalPaise).toBe(bill.totalPaise);
    expect(a.cgstPaise + b.cgstPaise).toBe(bill.cgstPaise);
    expect(a.taxablePaise + b.taxablePaise).toBe(bill.taxablePaise);
    expect(b.number).toMatch(/\/00002$/);
    expect(await codeOf(createReturn(ctx, back(invoiceId, branchId, [{ invoiceItemId: item, quantity: "1" }])))).toBe("RETURN_TOO_MANY");
    expect(await codeOf(createReturn(ctx, back(invoiceId, branchId, [{ invoiceItemId: randomUUID(), quantity: "1" }])))).toBe("ITEM_NOT_ON_BILL");
    expect(await level(ctx, variantId)).toBe("5.000");
  });

  it("damaged items are refunded but do not go back into stock", async () => {
    const ctx = await newShop("Return damaged");
    const { variantId, branchId } = await stocked(ctx, "5");
    const { invoiceId, itemIds } = await sold(ctx, branchId, [{ variantId, quantity: "2" }], pay(159_800));
    const { creditNoteId } = await createReturn(ctx, back(invoiceId, branchId, [{ invoiceItemId: itemIds[0] ?? "", quantity: "2", resellable: false }]));
    expect((await getCreditNote(ctx, { creditNoteId })).items[0]?.resellable).toBe(false);
    expect(await level(ctx, variantId)).toBe("3.000");
  });

  it("store credit lowers what the customer owes; a walk-in bill can only get money back", async () => {
    const ctx = await newShop("Return credit");
    const { variantId, branchId } = await stocked(ctx, "5");
    const { id: customerId } = await createCustomer(ctx, { name: "Credit back", phone: "", gstin: "", stateCode: "", creditLimitPaise: 200_000 });
    const onAccount = await sold(ctx, branchId, [{ variantId }], { customerId, payments: [] });
    expect((await getCustomer(ctx, { id: customerId })).balancePaise).toBe(79_900);
    await createReturn(ctx, back(onAccount.invoiceId, branchId, [{ invoiceItemId: onAccount.itemIds[0] ?? "", quantity: "1" }], { refundMethod: "store_credit" }));
    expect((await getCustomer(ctx, { id: customerId })).balancePaise).toBe(0);
    const walkIn = await sold(ctx, branchId, [{ variantId }], pay(79_900));
    expect(await codeOf(createReturn(ctx, back(walkIn.invoiceId, branchId, [{ invoiceItemId: walkIn.itemIds[0] ?? "", quantity: "1" }], { refundMethod: "store_credit" })))).toBe("STORE_CREDIT_NEEDS_CUSTOMER");
  });

  it("two tills returning the last item of a bill at once: exactly one succeeds", async () => {
    const ctx = await newShop("Return race");
    const { variantId, branchId } = await stocked(ctx, "5");
    const { invoiceId, itemIds } = await sold(ctx, branchId, [{ variantId }], pay(79_900));
    const results = await Promise.all(Array.from({ length: 10 }, () => codeOf(createReturn(ctx, back(invoiceId, branchId, [{ invoiceItemId: itemIds[0] ?? "", quantity: "1" }])))));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r !== "ok").every((r) => r === "RETURN_TOO_MANY")).toBe(true);
    expect(await level(ctx, variantId)).toBe("5.000");
  }, 120_000);
});

describe("the return window (7 days by default)", () => {
  it("after the window a cashier is refused; a manager may, and it is flagged", async () => {
    const owner = await newShop("Return window");
    const { variantId, branchId } = await stocked(owner, "5");
    await withTenant(owner, (tx) => tx.update(settings).set({ returnWindowDays: 0, timeZone: "Pacific/Pago_Pago" }));
    const { invoiceId, itemIds } = await sold(owner, branchId, [{ variantId }], pay(79_900));
    // Kiritimati is 25 hours ahead of Pago Pago: always the next day or later.
    await withTenant(owner, (tx) => tx.update(settings).set({ timeZone: "Pacific/Kiritimati" }));
    const cashier = await memberWithRole(owner, "Cashier");
    const line = [{ invoiceItemId: itemIds[0] ?? "", quantity: "1" }];
    expect(await codeOf(createReturn(cashier, back(invoiceId, branchId, line)))).toBe("RETURN_WINDOW_PASSED");
    const manager = await memberWithRole(owner, "Manager");
    const { creditNoteId } = await createReturn(manager, back(invoiceId, branchId, line));
    expect((await getCreditNote(owner, { creditNoteId })).outsideWindow).toBe(true);
    const audit = await withTenant(owner, (tx) => tx.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, creditNoteId)));
    expect(audit).toEqual([{ action: "sales.return_after_window" }]);
  });
});

describe("IMEI returns", () => {
  it("the phone sold on the bill comes back in stock (or scrapped if damaged), once", async () => {
    const ctx = await newShop("Return IMEI", "mobile");
    const { variantId, branchId } = await stocked(ctx, "2", { trackSerial: true, serials: ["IMEI-RET-0001", "IMEI-RET-0002"], price: 1_000_000 });
    const good = await sold(ctx, branchId, [{ variantId, serial: "IMEI-RET-0001" }], pay(1_000_000));
    const bad = await sold(ctx, branchId, [{ variantId, serial: "IMEI-RET-0002" }], pay(1_000_000));
    await createReturn(ctx, back(good.invoiceId, branchId, [{ invoiceItemId: good.itemIds[0] ?? "", quantity: "1" }]));
    const note = await createReturn(ctx, back(bad.invoiceId, branchId, [{ invoiceItemId: bad.itemIds[0] ?? "", quantity: "1", resellable: false }]));
    expect((await getCreditNote(ctx, note)).items[0]?.serial).toBe("IMEI-RET-0002");
    const rows = await withTenant(ctx, (tx) => tx.select({ serial: serialNumbers.serial, status: serialNumbers.status }).from(serialNumbers).orderBy(serialNumbers.serial));
    expect(rows).toEqual([
      { serial: "IMEI-RET-0001", status: "in_stock" },
      { serial: "IMEI-RET-0002", status: "scrapped" },
    ]);
    expect(await level(ctx, variantId)).toBe("1.000");
    // The returned phone can be sold again.
    expect(await codeOf(createSale(ctx, { idempotencyKey: randomUUID(), invoiceId: randomUUID(), branchId, lines: [{ variantId, quantity: "1", serial: "IMEI-RET-0001" }], ...pay(1_000_000) }))).toBe("ok");
  });
});

describe("bills and returns together", () => {
  it("a bill with a return cannot be voided; a voided bill cannot take returns", async () => {
    const ctx = await newShop("Return void");
    const { variantId, branchId } = await stocked(ctx, "5");
    const a = await sold(ctx, branchId, [{ variantId, quantity: "2" }], pay(159_800));
    await createReturn(ctx, back(a.invoiceId, branchId, [{ invoiceItemId: a.itemIds[0] ?? "", quantity: "1" }]));
    expect(await codeOf(voidInvoice(ctx, { idempotencyKey: randomUUID(), invoiceId: a.invoiceId, reason: "Try" }))).toBe("RETURNS_EXIST");
    const b = await sold(ctx, branchId, [{ variantId }], pay(79_900));
    await voidInvoice(ctx, { idempotencyKey: randomUUID(), invoiceId: b.invoiceId, reason: "Mistake" });
    expect(await codeOf(createReturn(ctx, back(b.invoiceId, branchId, [{ invoiceItemId: b.itemIds[0] ?? "", quantity: "1" }])))).toBe("INVOICE_VOIDED");
  });

  it("checks the input; a failed return uses no number", async () => {
    const ctx = await newShop("Return checks");
    const { variantId, branchId } = await stocked(ctx, "5");
    const { invoiceId, itemIds } = await sold(ctx, branchId, [{ variantId, quantity: "2" }], pay(159_800));
    const item = itemIds[0] ?? "";
    expect(await codeOf(createReturn(ctx, back(invoiceId, branchId, [])))).toBe("INVALID:lines");
    expect(await codeOf(createReturn(ctx, back(invoiceId, branchId, [{ invoiceItemId: item, quantity: "1" }], { reason: "" })))).toBe("INVALID:reason");
    expect(await codeOf(createReturn(ctx, back(invoiceId, branchId, [{ invoiceItemId: item, quantity: "0" }])))).toBe("BAD_BILL");
    expect(await codeOf(createReturn(ctx, back(invoiceId, branchId, [{ invoiceItemId: item, quantity: "1" }, { invoiceItemId: item, quantity: "1" }])))).toBe("BAD_BILL");
    expect(await codeOf(createReturn(ctx, back(invoiceId, branchId, [{ invoiceItemId: item, quantity: "1" }], { refundMethod: "gold" })))).toBe("INVALID:refundMethod");
    const ok = await createReturn(ctx, back(invoiceId, branchId, [{ invoiceItemId: item, quantity: "1" }]));
    expect((await getCreditNote(ctx, ok)).number).toMatch(/\/00001$/);
  });

  it("credit notes cannot be changed or deleted", async () => {
    const ctx = await newShop("Return locked");
    const { variantId, branchId } = await stocked(ctx, "5");
    const { invoiceId, itemIds } = await sold(ctx, branchId, [{ variantId }], pay(79_900));
    await createReturn(ctx, back(invoiceId, branchId, [{ invoiceItemId: itemIds[0] ?? "", quantity: "1" }]));
    await expect(withTenant(ctx, (tx) => tx.execute(sql`UPDATE credit_notes SET refund_paise = 1`))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.execute(sql`DELETE FROM credit_note_items`))).rejects.toThrow();
  });

  it("another business cannot return against or read this business's bills", async () => {
    const a = await newShop("Return A");
    const b = await newShop("Return B");
    const item = await stocked(b, "5");
    const { invoiceId, itemIds } = await sold(b, item.branchId, [{ variantId: item.variantId }], pay(79_900));
    const aBranch = (await listBranches(a))[0]?.id ?? "";
    expect(await codeOf(createReturn(a, back(invoiceId, aBranch, [{ invoiceItemId: itemIds[0] ?? "", quantity: "1" }])))).toBe("NOT_FOUND");
    expect(await codeOf(getReturnable(a, { invoiceId }))).toBe("NOT_FOUND");
    expect((await getReturnable(b, { invoiceId })).lines[0]?.remaining).toBe("1.000");
  });
});
