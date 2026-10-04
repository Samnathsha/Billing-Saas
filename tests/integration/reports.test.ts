import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { memberships, roles, settings } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { createProduct, getCatalogLists } from "@/modules/catalog";
import { addUsualExpenseCategories, listExpenseCategories, recordExpense } from "@/modules/expenses";
import { recordOpeningStock } from "@/modules/inventory";
import { createCustomer, createSupplier } from "@/modules/parties";
import { createPurchase } from "@/modules/purchasing";
import {
  getAgeing,
  getDashboard,
  getLowStock,
  getPaymentsReport,
  getProfitReport,
  getSalesBreakdown,
  getSalesReport,
  getStockValue,
  getTaxSummary,
  listAuditLog,
} from "@/modules/reports";
import * as reportsRepo from "@/modules/reports/repo";
import { createReturn, createSale, getReturnable, recordCustomerPayment, voidInvoice } from "@/modules/sales";
import { gstinCheckChar } from "@/modules/tax/gst";
import { listBranches } from "@/modules/tenants";
import { registerVerifiedUser } from "../helpers/auth";

// Reports (blueprint Phase 9): totals equal hand-worked sums for fixed
// bills; days follow the business's time zone; cashiers see no cost or
// profit; the audit log is Owner/Admin; other businesses see nothing.

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

async function memberWithRole(owner: TenantContext, role: string): Promise<TenantContext> {
  const user = await registerVerifiedUser(`Reports ${role}`);
  await withTenant(owner, async (tx) => {
    const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
    await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
  });
  const result = await getRequestContext(user.headers);
  if (result.kind !== "member") throw new Error("member");
  return result.ctx;
}

const today = (timeZone = "Asia/Kolkata") => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// A shirt at ₹799 (TEST 5%, price includes GST), 10 in stock at ₹400.
async function shirt(ctx: TenantContext, opts: { reorder?: string; stock?: string } = {}) {
  const lists = await getCatalogLists(ctx);
  const product = await createProduct(ctx, {
    name: `Shirt ${randomUUID().slice(0, 5)}`,
    unitId: lists.units.find((u) => u.code === "pcs")?.id ?? "",
    taxCategory: "test_5",
    variants: [{ sku: `R-${randomUUID().slice(0, 8)}`, sellingPricePaise: 79_900, costPricePaise: 40_000, reorderLevel: opts.reorder ?? "0" }],
  });
  const variantId = product.variants[0]?.id ?? "";
  const branchId = (await listBranches(ctx))[0]?.id ?? "";
  await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId, quantity: opts.stock ?? "10" }] });
  return { variantId, branchId };
}

const sell = (ctx: TenantContext, branchId: string, variantId: string, quantity: string, payments: { method: string; amountPaise: number }[], customerId: string | null = null) =>
  createSale(ctx, { idempotencyKey: randomUUID(), invoiceId: randomUUID(), branchId, customerId, lines: [{ variantId, quantity }], payments });

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof PermissionDeniedError) return error.code;
    if (error instanceof ZodError) return "INVALID";
    throw error;
  }
}

describe("a fixed day of trading, worked out by hand", () => {
  it("sales, returns, payments, profit and GST match the hand calculation", async () => {
    const ctx = await newShop("Reports day");
    const { variantId, branchId } = await shirt(ctx);
    const day = today();

    // Bill A: 2 shirts, cash ₹1,598. Bill B: 1 shirt, UPI ₹799, then voided.
    const a = await sell(ctx, branchId, variantId, "2", [{ method: "cash", amountPaise: 159_800 }]);
    const b = await sell(ctx, branchId, variantId, "1", [{ method: "upi", amountPaise: 79_900 }]);
    await voidInvoice(ctx, { idempotencyKey: randomUUID(), invoiceId: b.invoiceId, reason: "Mistake" });
    // One shirt of A back for cash: ₹799 (taxable 760.95, GST 38.06 = 19.03 x 2).
    const lineA = (await getReturnable(ctx, a)).lines[0]?.invoiceItemId;
    await createReturn(ctx, { idempotencyKey: randomUUID(), creditNoteId: randomUUID(), invoiceId: a.invoiceId, branchId, refundMethod: "cash", reason: "Size", lines: [{ invoiceItemId: lineA, quantity: "1", resellable: true }] });
    // A customer pays ₹300 by UPI; a ₹100 cash expense.
    const { id: customerId } = await createCustomer(ctx, { name: "Payer", phone: "", gstin: "", stateCode: "", creditLimitPaise: 0 });
    await recordCustomerPayment(ctx, { idempotencyKey: randomUUID(), customerId, branchId, method: "upi", amountPaise: 30_000 });
    await addUsualExpenseCategories(ctx);
    const tea = (await listExpenseCategories(ctx)).find((c) => c.name === "Tea and snacks")?.id;
    await recordExpense(ctx, { idempotencyKey: randomUUID(), branchId, categoryId: tea, amountPaise: 10_000, method: "cash", paidOn: day, description: "Tea" });

    const sales = await getSalesReport(ctx, { from: day, to: day });
    expect(sales).toMatchObject({
      bills: 1,
      voided: 1,
      salesPaise: 159_800,
      returnsPaise: 79_900,
      netSalesPaise: 79_900,
      taxablePaise: 152_190 - 76_095,
      taxPaise: 7610 - 3806,
      creditNotes: 1,
      days: [{ day, bills: 1, salesPaise: 159_800, returnsPaise: 79_900, netPaise: 79_900 }],
    });

    const payments = await getPaymentsReport(ctx, { from: day, to: day });
    // Cash: 1,598 in, 799 refunded, 100 expenses. UPI: 799 in then -799 (void), +300 customer payment.
    expect(payments.methods).toEqual([
      { method: "cash", receivedPaise: 159_800, refundedPaise: 79_900, expensesPaise: 10_000, netPaise: 69_900 },
      { method: "upi", receivedPaise: 30_000, refundedPaise: 0, expensesPaise: 0, netPaise: 30_000 },
    ]);

    // Profit: net sales 1,521.90 - 760.95 = 760.95; cost 800 - 400 = 400; gross 360.95; net 260.95.
    expect(await getProfitReport(ctx, { from: day, to: day })).toEqual({
      salesTaxablePaise: 152_190,
      returnsTaxablePaise: 76_095,
      netSalesPaise: 76_095,
      costOfGoodsPaise: 40_000,
      grossProfitPaise: 36_095,
      expensesPaise: 10_000,
      netProfitPaise: 26_095,
    });

    // Breakdowns add up line amounts, before each document's round-off: the
    // returned line is ₹799.01 (the credit note then rounds the refund to ₹799).
    const byItem = await getSalesBreakdown(ctx, { from: day, to: day, by: "item" });
    expect(byItem).toEqual([expect.objectContaining({ key: variantId, bills: 1, quantitySold: "2.000", quantityReturned: "1.000", salesPaise: 159_800, returnsPaise: 79_901, netPaise: 79_899 })]);
    expect((await getSalesBreakdown(ctx, { from: day, to: day, by: "category" }))[0]).toMatchObject({ name: "No category", netPaise: 79_899 });
    expect((await getSalesBreakdown(ctx, { from: day, to: day, by: "user" }))[0]).toMatchObject({ name: "Reports day Owner", salesPaise: 159_800 });

    const tax = await getTaxSummary(ctx, { from: day, to: day });
    expect(tax.output).toEqual([{ rate: "5.0000", taxablePaise: 76_095, cgstPaise: 1902, sgstPaise: 1902, igstPaise: 0 }]);
    expect(tax.outputTaxPaise).toBe(3804);

    // Stock: 10 - 2 - 1 + 1 (void) + 1 (return) = 9 at ₹400.
    expect(await getStockValue(ctx)).toMatchObject({ totalPaise: 360_000 });
  });

  it("another day shows nothing; the range must make sense", async () => {
    const ctx = await newShop("Reports range");
    expect(await getSalesReport(ctx, { from: "2020-01-01", to: "2020-01-31" })).toMatchObject({ bills: 0, salesPaise: 0, days: [] });
    expect(await codeOf(getSalesReport(ctx, { from: "2026-02-01", to: "2026-01-01" }))).toBe("INVALID");
    expect(await codeOf(getSalesReport(ctx, { from: "2024-01-01", to: "2026-01-01" }))).toBe("INVALID");
    expect(await codeOf(getSalesReport(ctx, { from: "2026-02-30", to: "2026-03-01" }))).toBe("INVALID");
  });
});

describe("days follow the business's time zone", () => {
  it("a sale at the same moment belongs to different days in Kiritimati and Pago Pago", async () => {
    const ctx = await newShop("Reports zones");
    const { variantId, branchId } = await shirt(ctx);
    await withTenant(ctx, (tx) => tx.update(settings).set({ timeZone: "Pacific/Kiritimati" }));
    await sell(ctx, branchId, variantId, "1", [{ method: "cash", amountPaise: 79_900 }]);
    const kiritimati = today("Pacific/Kiritimati");
    const pagoPago = today("Pacific/Pago_Pago");
    expect(kiritimati).not.toBe(pagoPago);
    expect((await getSalesReport(ctx, { from: kiritimati, to: kiritimati })).bills).toBe(1);
    expect((await getSalesReport(ctx, { from: pagoPago, to: pagoPago })).bills).toBe(0);
    // The audit log uses the same days.
    expect((await listAuditLog(ctx, { from: kiritimati, to: kiritimati, action: "sales" })).entries.length).toBeGreaterThan(0);
    expect((await listAuditLog(ctx, { from: pagoPago, to: pagoPago, action: "sales" })).entries).toEqual([]);
  });
});

describe("ageing and the dashboard", () => {
  it("payments clear the oldest amounts first; amounts move to older columns as days pass", async () => {
    const ctx = await newShop("Reports ageing");
    const { variantId, branchId } = await shirt(ctx);
    const { id: customerId } = await createCustomer(ctx, { name: "Slow Payer", phone: "", gstin: "", stateCode: "", creditLimitPaise: 1_000_000 });
    await sell(ctx, branchId, variantId, "1", [], customerId);
    await sell(ctx, branchId, variantId, "1", [], customerId);
    await recordCustomerPayment(ctx, { idempotencyKey: randomUUID(), customerId, branchId, method: "cash", amountPaise: 50_000 });
    expect(await getAgeing(ctx, { party: "customer" })).toEqual([
      { partyId: customerId, name: "Slow Payer", balancePaise: 109_800, days0to30Paise: 109_800, days31to60Paise: 0, days61to90Paise: 0, over90Paise: 0 },
    ]);
    // Seen from 45 days later, the same amounts are 31-60 days old.
    const later = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
    const [row] = await withTenant(ctx, async (tx) => reportsRepo.ageing(tx, "customer", later, "Asia/Kolkata"));
    expect(row).toMatchObject({ balance: "109800", d0_30: "0", d31_60: "109800" });

    const { id: supplierId } = await createSupplier(ctx, { name: "Owed Supplier", phone: "", gstin: "", stateCode: "33" });
    await createPurchase(ctx, { idempotencyKey: randomUUID(), supplierId, branchId, supplierInvoiceNumber: "S1", invoiceDate: today(), lines: [{ variantId, quantity: "2", unitPricePaise: 10_000, taxRate: "5" }] });
    const dashboard = await getDashboard(ctx);
    expect(dashboard).toMatchObject({ receivablesPaise: 109_800, payablesPaise: 21_000 });
    expect(dashboard.sales.bills).toBe(2);
    expect((await getAgeing(ctx, { party: "supplier" }))[0]).toMatchObject({ name: "Owed Supplier", balancePaise: 21_000 });
  });

  it("low stock lists items at or below their reorder level", async () => {
    const ctx = await newShop("Reports low");
    await shirt(ctx, { reorder: "10", stock: "4" });
    await shirt(ctx, { reorder: "2", stock: "8" });
    const low = await getLowStock(ctx);
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({ quantity: "4.000", reorderLevel: "10.000" });
  });
});

describe("who may see what", () => {
  it("a cashier sees no reports, cost or profit; an accountant sees reports and profit but not the audit log", async () => {
    const owner = await newShop("Reports roles");
    const day = today();
    const cashier = await memberWithRole(owner, "Cashier");
    for (const work of [
      () => getSalesReport(cashier, { from: day, to: day }),
      () => getProfitReport(cashier, { from: day, to: day }),
      () => getStockValue(cashier),
      () => getDashboard(cashier),
      () => getAgeing(cashier, { party: "customer" }),
      () => getTaxSummary(cashier, { from: day, to: day }),
      () => listAuditLog(cashier, { from: day, to: day }),
    ]) {
      expect(await codeOf(work())).toBe("FORBIDDEN");
    }
    const accountant = await memberWithRole(owner, "Accountant");
    expect(await codeOf(getProfitReport(accountant, { from: day, to: day }))).toBe("ok");
    expect(await codeOf(getStockValue(accountant))).toBe("ok");
    expect(await codeOf(listAuditLog(accountant, { from: day, to: day }))).toBe("FORBIDDEN");
    expect((await listAuditLog(owner, { from: day, to: day })).entries.length).toBeGreaterThan(0);
  });

  it("another business's sales never appear", async () => {
    const a = await newShop("Reports A");
    const b = await newShop("Reports B");
    const { variantId, branchId } = await shirt(b);
    await sell(b, branchId, variantId, "3", [{ method: "cash", amountPaise: 239_700 }]);
    const day = today();
    expect(await getSalesReport(a, { from: day, to: day })).toMatchObject({ bills: 0, salesPaise: 0 });
    expect(await getStockValue(a)).toMatchObject({ totalPaise: 0 });
    expect((await listAuditLog(a, { from: day, to: day, action: "sales" })).entries).toEqual([]);
    expect((await getSalesReport(b, { from: day, to: day })).salesPaise).toBe(239_700);
  });
});
