import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auditLogs, invoices, memberships, partyLedgerEntries, roles, serialNumbers, settings } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { createProduct, getCatalogLists, setProductArchived } from "@/modules/catalog";
import { getStockLevels, InventoryError, recordOpeningStock, StockError } from "@/modules/inventory";
import { createCustomer, getCustomer, PartyError } from "@/modules/parties";
import { createSale, getInvoice, listInvoices, SalesError, voidInvoice } from "@/modules/sales";
import { gstinCheckChar } from "@/modules/tax/gst";
import { listBranches } from "@/modules/tenants";
import { registerVerifiedUser } from "../helpers/auth";

// The sale (blueprint 7.5): money exactly right, one bill per click, prices
// from the database only, discount and credit limits, two tills and the
// last unit, failures undo everything (bill number included), IMEI and
// warranty, the same-day void, and other businesses.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

const gstin = (state: string) => {
  const first14 = `${state}ABCDE1234F1Z`;
  return first14 + gstinCheckChar(first14);
};

type Registration = "registered" | "composition" | "unregistered";

async function newShop(label: string, registration: Registration = "registered", template: "clothing" | "mobile" = "clothing"): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template });
  const r = await getRequestContext(owner.headers);
  if (r.kind !== "member") throw new Error("expected a member");
  await withTenant(r.ctx, (tx) => tx.update(settings).set({ gstRegistration: registration, gstin: registration === "unregistered" ? null : gstin("33"), stateCode: "33" }));
  return r.ctx;
}

async function memberWithRole(owner: TenantContext, role: string): Promise<TenantContext> {
  const user = await registerVerifiedUser(`Sales ${role}`);
  await withTenant(owner, async (tx) => {
    const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
    await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
  });
  const result = await getRequestContext(user.headers);
  if (result.kind !== "member") throw new Error("member");
  return result.ctx;
}

// An item at ₹799 (TEST 5%) with `stock` pieces in the main branch.
async function stocked(ctx: TenantContext, stock: string, opts: { price?: number; tax?: string; trackSerial?: boolean; serials?: string[]; warranty?: number } = {}) {
  const lists = await getCatalogLists(ctx);
  const product = await createProduct(ctx, {
    name: `Item ${randomUUID().slice(0, 6)}`,
    unitId: lists.units.find((u) => u.code === "pcs")?.id ?? "",
    taxCategory: opts.tax ?? "test_5",
    hsnCode: "6205",
    trackSerial: opts.trackSerial ?? false,
    ...(opts.warranty !== undefined ? { warrantyMonths: opts.warranty } : {}),
    ...(lists.template === "mobile" ? { attributes: { model: "M1" } } : {}),
    variants: [{ sku: `S-${randomUUID().slice(0, 8)}`, sellingPricePaise: opts.price ?? 79_900, costPricePaise: 45_000 }],
  });
  const branchId = (await listBranches(ctx))[0]?.id ?? "";
  const variantId = product.variants[0]?.id ?? "";
  if (stock !== "0") {
    await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId, quantity: stock, serials: opts.serials ?? [] }] });
  }
  return { variantId, branchId, productId: product.id };
}

const sale = (branchId: string, lines: { variantId: string; quantity?: string; discountPaise?: number; serial?: string }[], extra: Record<string, unknown> = {}) => ({
  idempotencyKey: randomUUID(),
  invoiceId: randomUUID(),
  branchId,
  lines: lines.map((l) => ({ quantity: "1", ...l })),
  ...extra,
});

const cash = (amountPaise: number) => [{ method: "cash", amountPaise }];

async function level(ctx: TenantContext, variantId: string): Promise<string> {
  return (await getStockLevels(ctx, { variantIds: [variantId] }))[0]?.quantity ?? "0.000";
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (
      error instanceof SalesError ||
      error instanceof StockError ||
      error instanceof InventoryError ||
      error instanceof PartyError ||
      error instanceof PermissionDeniedError
    ) {
      return error.code;
    }
    if (error instanceof ZodError) return `INVALID:${error.issues.map((i) => i.path.join(".")).join(",")}`;
    throw error;
  }
}

const countInvoices = async (ctx: TenantContext) => (await withTenant(ctx, (tx) => tx.select({ id: invoices.id }).from(invoices))).length;

describe("a cash sale", () => {
  it("prices including GST: 2 x ₹799 at 5% = ₹1,598.00 with CGST ₹38.05 + SGST ₹38.05; stock, number, snapshot, payment and audit", async () => {
    const ctx = await newShop("Sale cash");
    const { variantId, branchId } = await stocked(ctx, "5");
    const input = sale(branchId, [{ variantId, quantity: "2" }], { payments: cash(159_800) });
    const { invoiceId } = await createSale(ctx, input);
    const bill = await getInvoice(ctx, { invoiceId });
    // 159800 / 1.05 = 152190.48 -> 152190; half of 5% = 3804.75 -> 3805 each; taxable 159800 - 7610
    expect(bill).toMatchObject({
      status: "posted",
      grossPaise: 159_800,
      discountPaise: 0,
      taxablePaise: 152_190,
      cgstPaise: 3805,
      sgstPaise: 3805,
      igstPaise: 0,
      totalPaise: 159_800,
      roundOffPaise: 0,
      payablePaise: 159_800,
      paidPaise: 159_800,
      creditPaise: 0,
      placeOfSupply: "33",
      interState: false,
      seller: { name: "Sale cash Shop", gstin: gstin("33"), stateCode: "33", gstRegistration: "registered" },
      buyer: { customerId: null, name: null },
    });
    expect(bill.number).toMatch(/^INV\/\d{2}-\d{2}\/00001$/);
    expect(bill.items).toEqual([
      expect.objectContaining({ lineNumber: 1, quantity: "2.000", unitPricePaise: 79_900, hsnCode: "6205", unitCode: "pcs", taxLabel: "TEST 5%", taxRate: "5.0000", totalPaise: 159_800, unitCostPaise: "45000.0000" }),
    ]);
    expect(bill.payments).toEqual([{ method: "cash", amountPaise: 159_800, reference: null, kind: "sale" }]);
    expect(await level(ctx, variantId)).toBe("3.000");
    const audit = await withTenant(ctx, (tx) => tx.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, invoiceId)));
    expect(audit).toEqual([{ action: "sales.invoice_created" }]);
    expect((await listInvoices(ctx))[0]).toMatchObject({ id: invoiceId, number: bill.number, payablePaise: 159_800 });
  });

  it("round-off to the rupee; split payment (cash + UPI)", async () => {
    const ctx = await newShop("Sale round");
    const { variantId, branchId } = await stocked(ctx, "5", { price: 10_050 }); // ₹100.50
    const { invoiceId } = await createSale(ctx, sale(branchId, [{ variantId }], { payments: [{ method: "cash", amountPaise: 5000 }, { method: "upi", amountPaise: 5100, reference: "UPI 123" }] }));
    expect(await getInvoice(ctx, { invoiceId })).toMatchObject({ totalPaise: 10_050, roundOffPaise: 50, payablePaise: 10_100, paidPaise: 10_100, creditPaise: 0 });
  });

  it("prices without GST: tax added on top", async () => {
    const ctx = await newShop("Sale exclusive");
    await withTenant(ctx, (tx) => tx.update(settings).set({ pricesIncludeTax: false }));
    const { variantId, branchId } = await stocked(ctx, "5", { price: 10_000, tax: "test_18" });
    const { invoiceId } = await createSale(ctx, sale(branchId, [{ variantId }], { payments: cash(11_800) }));
    expect(await getInvoice(ctx, { invoiceId })).toMatchObject({ taxablePaise: 10_000, cgstPaise: 900, sgstPaise: 900, totalPaise: 11_800, payablePaise: 11_800 });
  });

  it("a composition business issues a bill of supply: no GST", async () => {
    const ctx = await newShop("Sale composition", "composition");
    const { variantId, branchId } = await stocked(ctx, "5");
    const { invoiceId } = await createSale(ctx, sale(branchId, [{ variantId }], { payments: cash(79_900) }));
    const bill = await getInvoice(ctx, { invoiceId });
    expect(bill).toMatchObject({ chargesGst: false, taxPaise: 0, taxablePaise: 79_900, totalPaise: 79_900 });
    expect(bill.items[0]).toMatchObject({ taxLabel: "No GST (bill of supply)", taxRate: "0.0000" });
  });

  it("a registered buyer in another state: IGST; their details are on the bill", async () => {
    const ctx = await newShop("Sale IGST");
    const { variantId, branchId } = await stocked(ctx, "5");
    const { id: customerId } = await createCustomer(ctx, { name: "Bengaluru Traders", phone: "", gstin: gstin("29"), stateCode: "", address: "1 MG Road, Bengaluru" });
    const { invoiceId } = await createSale(ctx, sale(branchId, [{ variantId }], { customerId, payments: cash(79_900) }));
    // 79900 / 1.05 = 76095.24 -> 76095; IGST 3805
    expect(await getInvoice(ctx, { invoiceId })).toMatchObject({
      interState: true,
      placeOfSupply: "29",
      taxablePaise: 76_095,
      igstPaise: 3805,
      cgstPaise: 0,
      buyer: { customerId, name: "Bengaluru Traders", gstin: gstin("29"), address: "1 MG Road, Bengaluru" },
    });
  });
});

describe("one bill per sale", () => {
  it("a retry or a double click saves one bill, takes stock once and one number", async () => {
    const ctx = await newShop("Sale retry");
    const { variantId, branchId } = await stocked(ctx, "5");
    const input = sale(branchId, [{ variantId }], { payments: cash(79_900) });
    const results = await Promise.all(Array.from({ length: 5 }, () => createSale(ctx, input)));
    expect(new Set(results.map((r) => r.invoiceId))).toEqual(new Set([input.invoiceId]));
    expect(await countInvoices(ctx)).toBe(1);
    expect(await level(ctx, variantId)).toBe("4.000");
    const next = await createSale(ctx, sale(branchId, [{ variantId }], { payments: cash(79_900) }));
    expect((await getInvoice(ctx, next)).number).toMatch(/\/00002$/);
  }, 120_000);

  it("the same bill id under another key is refused", async () => {
    const ctx = await newShop("Sale same id");
    const { variantId, branchId } = await stocked(ctx, "5");
    const input = sale(branchId, [{ variantId }], { payments: cash(79_900) });
    await createSale(ctx, input);
    expect(await codeOf(createSale(ctx, { ...input, idempotencyKey: randomUUID() }))).toBe("DUPLICATE_INVOICE");
    expect(await level(ctx, variantId)).toBe("4.000");
  });
});

describe("prices come from the database only", () => {
  it("a price sent by the browser is refused outright; a changed total is refused before charging", async () => {
    const ctx = await newShop("Sale tamper");
    const { variantId, branchId } = await stocked(ctx, "5");
    expect(await codeOf(createSale(ctx, { ...sale(branchId, [{ variantId }]), lines: [{ variantId, quantity: "1", unitPricePaise: 1 }] }))).toBe("INVALID:lines.0");
    expect(await codeOf(createSale(ctx, sale(branchId, [{ variantId }], { payments: cash(100), expectedPayablePaise: 100 })))).toBe("PRICES_CHANGED");
    expect(await codeOf(createSale(ctx, sale(branchId, [{ variantId }], { payments: cash(79_900), expectedPayablePaise: 79_900 })))).toBe("ok");
    expect(await countInvoices(ctx)).toBe(1);
  });

  it("archived items and missing settings are refused", async () => {
    const ctx = await newShop("Sale archived");
    const { variantId, branchId, productId } = await stocked(ctx, "5");
    await setProductArchived(ctx, { id: productId, archived: true });
    expect(await codeOf(createSale(ctx, sale(branchId, [{ variantId }], { payments: cash(79_900) })))).toBe("ITEM_ARCHIVED");
    const unset = await newShop("Sale unset");
    const item = await stocked(unset, "1");
    await withTenant(unset, (tx) => tx.update(settings).set({ gstRegistration: null, gstin: null }));
    expect(await codeOf(createSale(unset, sale(item.branchId, [{ variantId: item.variantId }])))).toBe("SETTINGS_INCOMPLETE");
  });
});

describe("discounts", () => {
  it("a cashier up to 5%; a manager without limit", async () => {
    const owner = await newShop("Sale discount");
    const { variantId, branchId } = await stocked(owner, "5", { price: 10_000 });
    const cashier = await memberWithRole(owner, "Cashier");
    const manager = await memberWithRole(owner, "Manager");
    expect(await codeOf(createSale(cashier, sale(branchId, [{ variantId, discountPaise: 501 }], { payments: cash(9500) })))).toBe("DISCOUNT_OVER_LIMIT");
    expect(await codeOf(createSale(cashier, sale(branchId, [{ variantId }], { billDiscountPaise: 501, payments: cash(9500) })))).toBe("DISCOUNT_OVER_LIMIT");
    expect(await codeOf(createSale(cashier, sale(branchId, [{ variantId, discountPaise: 500 }], { payments: cash(9500) })))).toBe("ok");
    const { invoiceId } = await createSale(manager, sale(branchId, [{ variantId, discountPaise: 5000 }], { payments: cash(5000) }));
    expect(await getInvoice(owner, { invoiceId })).toMatchObject({ discountPaise: 5000, payablePaise: 5000 });
  });
});

describe("payments and credit", () => {
  it("part on credit within the customer's limit; over the limit refused; credit needs a customer; overpaying refused", async () => {
    const ctx = await newShop("Sale credit");
    const { variantId, branchId } = await stocked(ctx, "5", { price: 100_000 });
    const { id: customerId } = await createCustomer(ctx, { name: "Udhaar", phone: "98400 66666", gstin: "", stateCode: "", creditLimitPaise: 150_000 });
    const { invoiceId } = await createSale(ctx, sale(branchId, [{ variantId }], { customerId, payments: cash(20_000) }));
    expect(await getInvoice(ctx, { invoiceId })).toMatchObject({ paidPaise: 20_000, creditPaise: 80_000, buyer: { name: "Udhaar", phone: "98400 66666" } });
    expect((await getCustomer(ctx, { id: customerId })).balancePaise).toBe(80_000);
    expect(await codeOf(createSale(ctx, sale(branchId, [{ variantId }], { customerId, payments: cash(29_999) })))).toBe("OVER_CREDIT_LIMIT");
    expect(await codeOf(createSale(ctx, sale(branchId, [{ variantId }], { customerId, payments: cash(30_000) })))).toBe("ok");
    expect((await getCustomer(ctx, { id: customerId })).balancePaise).toBe(150_000);
    expect(await codeOf(createSale(ctx, sale(branchId, [{ variantId }], { payments: cash(50_000) })))).toBe("CREDIT_NEEDS_CUSTOMER");
    expect(await codeOf(createSale(ctx, sale(branchId, [{ variantId }], { payments: cash(100_001) })))).toBe("OVERPAID");
    expect(await level(ctx, variantId)).toBe("3.000");
  });
});

describe("two tills, one last unit", () => {
  it("exactly one sale wins; the others are refused; numbers stay without gaps", async () => {
    const ctx = await newShop("Sale last unit");
    const { variantId, branchId } = await stocked(ctx, "1");
    const results = await Promise.all(Array.from({ length: 10 }, () => codeOf(createSale(ctx, sale(branchId, [{ variantId }], { payments: cash(79_900) })))));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r !== "ok").every((r) => r === "INSUFFICIENT_STOCK")).toBe(true);
    expect(await level(ctx, variantId)).toBe("0.000");
    const bills = await listInvoices(ctx);
    expect(bills.map((b) => b.number.slice(-5))).toEqual(["00001"]);
  }, 120_000);
});

describe("a failure anywhere undoes everything, the bill number included", () => {
  it.each([
    ["an IMEI that is not in stock (step 5)", "SERIAL_NOT_IN_STOCK"],
    ["over the credit limit (step 6)", "OVER_CREDIT_LIMIT"],
    ["not enough stock on the last line (step 9)", "INSUFFICIENT_STOCK"],
  ])("%s", async (kind, expected) => {
    const ctx = await newShop(`Sale rollback ${expected}`, "registered", "mobile");
    const plain = await stocked(ctx, "5", { price: 10_000 });
    const phone = await stocked(ctx, "1", { trackSerial: true, serials: ["IMEI-IN-0001"], price: 10_000 });
    const short = await stocked(ctx, "1", { price: 10_000 });
    const { id: customerId } = await createCustomer(ctx, { name: "Small limit", phone: "", gstin: "", stateCode: "", creditLimitPaise: 100 });
    const lines =
      kind.startsWith("an IMEI")
        ? [{ variantId: plain.variantId }, { variantId: phone.variantId, serial: "IMEI-NOT-THERE" }]
        : kind.startsWith("not enough")
          ? [{ variantId: plain.variantId }, { variantId: short.variantId, quantity: "2" }]
          : [{ variantId: plain.variantId }];
    const extra = kind.startsWith("over") ? { customerId, payments: [] } : { customerId, payments: cash(100_000).map((p) => ({ ...p, amountPaise: 10_000 * lines.length + (kind.startsWith("not") ? 10_000 : 0) })) };
    expect(await codeOf(createSale(ctx, sale(plain.branchId, lines, extra)))).toBe(expected);
    expect(await countInvoices(ctx)).toBe(0);
    expect(await level(ctx, plain.variantId)).toBe("5.000");
    expect((await getCustomer(ctx, { id: customerId })).balancePaise).toBe(0);
    expect(await withTenant(ctx, (tx) => tx.select().from(partyLedgerEntries))).toEqual([]);
    // The number was given back: the next good sale is 00001.
    const ok = await createSale(ctx, sale(plain.branchId, [{ variantId: plain.variantId }], { payments: cash(10_000) }));
    expect((await getInvoice(ctx, ok)).number).toMatch(/\/00001$/);
  });
});

describe("IMEI items", () => {
  it("each phone is sold once, with its IMEI on the bill and a warranty end date", async () => {
    const ctx = await newShop("Sale IMEI", "registered", "mobile");
    const { variantId, branchId } = await stocked(ctx, "2", { trackSerial: true, serials: ["IMEI-SALE-0001", "IMEI-SALE-0002"], warranty: 12, price: 1_000_000 });
    expect(await codeOf(createSale(ctx, sale(branchId, [{ variantId }], { payments: cash(1_000_000) })))).toBe("ONE_IMEI_PER_LINE");
    expect(await codeOf(createSale(ctx, sale(branchId, [{ variantId, quantity: "2", serial: "IMEI-SALE-0001" }], { payments: cash(2_000_000) })))).toBe("ONE_IMEI_PER_LINE");
    const { invoiceId } = await createSale(ctx, sale(branchId, [{ variantId, serial: "imei-sale-0001" }], { payments: cash(1_000_000) }));
    expect((await getInvoice(ctx, { invoiceId })).items[0]?.serial).toBe("IMEI-SALE-0001");
    const [row] = await withTenant(ctx, (tx) => tx.select({ status: serialNumbers.status, warranty: serialNumbers.warrantyEndsOn, item: serialNumbers.invoiceItemId }).from(serialNumbers).where(eq(serialNumbers.serial, "IMEI-SALE-0001")));
    const today = (await getInvoice(ctx, { invoiceId })).invoiceDate;
    expect(row?.status).toBe("sold");
    expect(row?.item).not.toBeNull();
    // 12 months later (a 29 February sale would end on 28 February).
    expect(row?.warranty).toBe(`${String(Number(today.slice(0, 4)) + 1)}${today.slice(4)}`);
    expect(await codeOf(createSale(ctx, sale(branchId, [{ variantId, serial: "IMEI-SALE-0001" }], { payments: cash(1_000_000) })))).toBe("SERIAL_NOT_IN_STOCK");
    expect(await level(ctx, variantId)).toBe("1.000");
  });
});

describe("voiding a bill (same day, manager or above)", () => {
  it("stock, money and the customer's account go back; the bill's own rows stay; once only", async () => {
    const owner = await newShop("Sale void", "registered", "mobile");
    const phone = await stocked(owner, "1", { trackSerial: true, serials: ["IMEI-VOID-0001"], price: 100_000 });
    const plain = await stocked(owner, "3", { price: 50_000 });
    const { id: customerId } = await createCustomer(owner, { name: "Void customer", phone: "", gstin: "", stateCode: "", creditLimitPaise: 100_000 });
    const { invoiceId } = await createSale(
      owner,
      sale(phone.branchId, [{ variantId: phone.variantId, serial: "IMEI-VOID-0001" }, { variantId: plain.variantId, quantity: "2" }], { customerId, payments: [{ method: "upi", amountPaise: 150_000 }] }),
    );
    expect((await getCustomer(owner, { id: customerId })).balancePaise).toBe(50_000);

    const cashier = await memberWithRole(owner, "Cashier");
    expect(await codeOf(voidInvoice(cashier, { idempotencyKey: randomUUID(), invoiceId, reason: "Wrong" }))).toBe("FORBIDDEN");
    const manager = await memberWithRole(owner, "Manager");
    const key = randomUUID();
    await voidInvoice(manager, { idempotencyKey: key, invoiceId, reason: "Customer changed mind" });
    expect(await voidInvoice(manager, { idempotencyKey: key, invoiceId, reason: "Customer changed mind" })).toEqual({ invoiceId });
    expect(await codeOf(voidInvoice(manager, { idempotencyKey: randomUUID(), invoiceId, reason: "Again" }))).toBe("ALREADY_VOIDED");

    const bill = await getInvoice(owner, { invoiceId });
    expect(bill).toMatchObject({ status: "voided", voidReason: "Customer changed mind", payablePaise: 200_000, creditPaise: 50_000 });
    expect(bill.payments).toEqual([
      { method: "upi", amountPaise: 150_000, reference: null, kind: "sale" },
      { method: "upi", amountPaise: -150_000, reference: null, kind: "void" },
    ]);
    expect(await level(owner, phone.variantId)).toBe("1.000");
    expect(await level(owner, plain.variantId)).toBe("3.000");
    expect((await getCustomer(owner, { id: customerId })).balancePaise).toBe(0);
    const [serial] = await withTenant(owner, (tx) => tx.select({ status: serialNumbers.status }).from(serialNumbers).where(eq(serialNumbers.serial, "IMEI-VOID-0001")));
    expect(serial?.status).toBe("in_stock");
    // The phone can be sold again.
    expect(await codeOf(createSale(owner, sale(phone.branchId, [{ variantId: phone.variantId, serial: "IMEI-VOID-0001" }], { payments: cash(100_000) })))).toBe("ok");
  });

  it("only on the day of the bill", async () => {
    const ctx = await newShop("Sale void late");
    const { variantId, branchId } = await stocked(ctx, "2");
    await withTenant(ctx, (tx) => tx.update(settings).set({ timeZone: "Pacific/Kiritimati" }));
    const { invoiceId } = await createSale(ctx, sale(branchId, [{ variantId }], { payments: cash(79_900) }));
    // Pago Pago is 25 hours behind Kiritimati: always a different day.
    await withTenant(ctx, (tx) => tx.update(settings).set({ timeZone: "Pacific/Pago_Pago" }));
    expect(await codeOf(voidInvoice(ctx, { idempotencyKey: randomUUID(), invoiceId, reason: "Too late" }))).toBe("VOID_ONLY_SAME_DAY");
    expect((await getInvoice(ctx, { invoiceId })).status).toBe("posted");
  });

  it("a posted bill cannot be edited or deleted, even directly", async () => {
    const ctx = await newShop("Sale locked");
    const { variantId, branchId } = await stocked(ctx, "2");
    const { invoiceId } = await createSale(ctx, sale(branchId, [{ variantId }], { payments: cash(79_900) }));
    await expect(withTenant(ctx, (tx) => tx.update(invoices).set({ payablePaise: 1 }).where(eq(invoices.id, invoiceId)))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.update(invoices).set({ status: "voided", voidReason: "x", voidedAt: new Date(), voidedBy: ctx.userId, buyerName: "changed" }).where(eq(invoices.id, invoiceId)))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.delete(invoices).where(eq(invoices.id, invoiceId)))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.execute(sql`UPDATE invoice_items SET total_paise = 1`))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.execute(sql`DELETE FROM invoice_payments`))).rejects.toThrow();
    expect((await getInvoice(ctx, { invoiceId })).payablePaise).toBe(79_900);
  });
});

describe("who may sell, and another business", () => {
  it("an accountant may read bills but not sell", async () => {
    const owner = await newShop("Sale roles");
    const { variantId, branchId } = await stocked(owner, "2");
    const { invoiceId } = await createSale(owner, sale(branchId, [{ variantId }], { payments: cash(79_900) }));
    const accountant = await memberWithRole(owner, "Accountant");
    expect(await codeOf(createSale(accountant, sale(branchId, [{ variantId }], { payments: cash(79_900) })))).toBe("FORBIDDEN");
    expect((await getInvoice(accountant, { invoiceId })).items[0]?.unitCostPaise).toBe("45000.0000");
    const cashier = await memberWithRole(owner, "Cashier");
    expect((await getInvoice(cashier, { invoiceId })).items[0]?.unitCostPaise).toBeUndefined();
  });

  it("another business cannot read, void or sell from this one", async () => {
    const a = await newShop("Sale A");
    const b = await newShop("Sale B");
    const itemB = await stocked(b, "2");
    const { invoiceId } = await createSale(b, sale(itemB.branchId, [{ variantId: itemB.variantId }], { payments: cash(79_900) }));
    const aBranch = (await listBranches(a))[0]?.id ?? "";
    expect(await codeOf(getInvoice(a, { invoiceId }))).toBe("NOT_FOUND");
    expect(await codeOf(voidInvoice(a, { idempotencyKey: randomUUID(), invoiceId, reason: "Attack" }))).toBe("NOT_FOUND");
    expect(await codeOf(createSale(a, sale(aBranch, [{ variantId: itemB.variantId }], { payments: cash(79_900) })))).toBe("ITEM_NOT_FOUND");
    expect(await listInvoices(a)).toEqual([]);
    expect((await getInvoice(b, { invoiceId })).status).toBe("posted");
    expect(await level(b, itemB.variantId)).toBe("1.000");
  });
});
