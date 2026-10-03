import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auditLogs, memberships, partyLedgerEntries, purchases, roles, serialNumbers, settings, stockMovements } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { createProduct, getCatalogLists } from "@/modules/catalog";
import { adjustStock, getStockLevels, InventoryError, recordOpeningStock, StockError } from "@/modules/inventory";
import { createSupplier, getSupplierStatement, listSuppliers, PartyError, setSupplierArchived } from "@/modules/parties";
import { createPurchase, getPurchase, listPurchases, PurchaseError, recordSupplierPayment, voidPurchase } from "@/modules/purchasing";
import { listBranches } from "@/modules/tenants";
import { gstinCheckChar } from "@/modules/tax/gst";
import { registerVerifiedUser } from "../helpers/auth";

// Purchases (business rules 14): one transaction for bill, stock, IMEI,
// supplier account, payment and audit; retries post once; GST is cost only
// when it cannot be claimed back; duplicates refused; a void reverses
// everything or nothing; other businesses.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

const TN_GSTIN = (() => {
  const first14 = "33ABCDE1234F1Z";
  return first14 + gstinCheckChar(first14);
})();

type Registration = "registered" | "composition" | "unregistered" | null;

async function newShop(label: string, registration: Registration = "registered", template: "clothing" | "mobile" = "clothing"): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template });
  const r = await getRequestContext(owner.headers);
  if (r.kind !== "member") throw new Error("expected a member");
  if (registration !== null) {
    await withTenant(r.ctx, (tx) =>
      tx.update(settings).set({ gstRegistration: registration, gstin: registration === "unregistered" ? null : TN_GSTIN, stateCode: "33" }),
    );
  }
  return r.ctx;
}

async function memberWithRole(owner: TenantContext, role: string): Promise<TenantContext> {
  const user = await registerVerifiedUser(`Purchase ${role}`);
  await withTenant(owner, async (tx) => {
    const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
    await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
  });
  const result = await getRequestContext(user.headers);
  if (result.kind !== "member") throw new Error("member");
  return result.ctx;
}

async function item(ctx: TenantContext, opts: { unit?: "pcs" | "m"; trackSerial?: boolean } = {}): Promise<string> {
  const lists = await getCatalogLists(ctx);
  const unitId = lists.units.find((u) => u.code === (opts.unit ?? "pcs"))?.id ?? "";
  const product = await createProduct(ctx, {
    name: `Item ${randomUUID().slice(0, 6)}`,
    unitId,
    taxCategory: "test_5",
    trackSerial: opts.trackSerial ?? false,
    ...(lists.template === "mobile" ? { attributes: { model: "M1" } } : {}),
    variants: [{ sku: `S-${randomUUID().slice(0, 8)}`, sellingPricePaise: 100_000 }],
  });
  return product.variants[0]?.id ?? "";
}

async function setup(ctx: TenantContext) {
  const branchId = (await listBranches(ctx))[0]?.id ?? "";
  const { id: supplierId } = await createSupplier(ctx, { name: `Supplier ${randomUUID().slice(0, 6)}`, phone: "", gstin: "", stateCode: "33" });
  return { branchId, supplierId };
}

const bill = (
  s: { branchId: string; supplierId: string },
  lines: { variantId: string; quantity: string; unitPricePaise: number; taxRate?: string; serials?: string[] }[],
  extra: Record<string, unknown> = {},
) => ({
  idempotencyKey: randomUUID(),
  supplierId: s.supplierId,
  branchId: s.branchId,
  supplierInvoiceNumber: `B-${randomUUID().slice(0, 6)}`,
  invoiceDate: "2026-09-01",
  lines: lines.map((l) => ({ taxRate: "18", ...l })),
  ...extra,
});

async function level(ctx: TenantContext, variantId: string) {
  const rows = await getStockLevels(ctx, { variantIds: [variantId] });
  return rows[0] ?? { quantity: "0.000", averageCostPaise: "0.0000" };
}

const balanceOf = async (ctx: TenantContext, supplierId: string) => (await getSupplierStatement(ctx, { supplierId })).supplier.balancePaise;

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (
      error instanceof PurchaseError ||
      error instanceof PartyError ||
      error instanceof StockError ||
      error instanceof InventoryError ||
      error instanceof PermissionDeniedError
    ) {
      return error.code;
    }
    if (error instanceof ZodError) return `INVALID:${error.issues.map((i) => i.path.join(".")).join(",")}`;
    throw error;
  }
}

describe("posting a purchase", () => {
  it("registered business: stock in at cost without GST, supplier owes the total, audited; a retry posts nothing more", async () => {
    const ctx = await newShop("Purchase post");
    const s = await setup(ctx);
    const shirt = await item(ctx);
    const trouser = await item(ctx);
    const input = bill(s, [
      { variantId: shirt, quantity: "10", unitPricePaise: 50_000 },
      { variantId: trouser, quantity: "3", unitPricePaise: 3333, taxRate: "12" },
    ]);
    const first = await createPurchase(ctx, input);
    const again = await createPurchase(ctx, input);
    expect(again).toEqual(first);

    expect(await level(ctx, shirt)).toMatchObject({ quantity: "10.000", averageCostPaise: "50000.0000" });
    expect(await level(ctx, trouser)).toMatchObject({ quantity: "3.000", averageCostPaise: "3333.0000" });
    // 5,00,000 + 90,000 GST; 9,999 + 1,200 GST
    const detail = await getPurchase(ctx, first);
    expect(detail).toMatchObject({ status: "posted", subtotalPaise: 509_999, taxPaise: 91_200, totalPaise: 601_199, paidPaise: 0, costBasis: "excludes_tax" });
    expect(detail.items).toEqual([
      { lineNumber: 1, variantId: shirt, quantity: "10.000", unitPricePaise: 50_000, taxRate: "18.0000", subtotalPaise: 500_000, taxPaise: 90_000, totalPaise: 590_000, unitCostPaise: "50000.0000" },
      { lineNumber: 2, variantId: trouser, quantity: "3.000", unitPricePaise: 3333, taxRate: "12.0000", subtotalPaise: 9999, taxPaise: 1200, totalPaise: 11_199, unitCostPaise: "3333.0000" },
    ]);
    expect(await balanceOf(ctx, s.supplierId)).toBe(601_199);
    expect(await listPurchases(ctx)).toHaveLength(1);
    const movements = await withTenant(ctx, (tx) => tx.select({ type: stockMovements.movementType }).from(stockMovements).where(eq(stockMovements.sourceId, first.purchaseId)));
    expect(movements).toEqual([{ type: "PURCHASE_IN" }, { type: "PURCHASE_IN" }]);
    const audit = await withTenant(ctx, (tx) => tx.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, first.purchaseId)));
    expect(audit).toEqual([{ action: "purchases.created" }]);
  });

  it("composition and unregistered businesses: the GST paid is part of the cost", async () => {
    for (const registration of ["composition", "unregistered"] as const) {
      const ctx = await newShop(`Purchase ${registration}`, registration);
      const s = await setup(ctx);
      const shirt = await item(ctx);
      const { purchaseId } = await createPurchase(ctx, bill(s, [{ variantId: shirt, quantity: "10", unitPricePaise: 50_000 }]));
      expect(await level(ctx, shirt)).toMatchObject({ averageCostPaise: "59000.0000" });
      expect(await getPurchase(ctx, { purchaseId })).toMatchObject({ costBasis: "includes_tax", totalPaise: 590_000 });
    }
  });

  it("is refused until the GST registration is set", async () => {
    const ctx = await newShop("Purchase no GST", null);
    const s = await setup(ctx);
    expect(await codeOf(createPurchase(ctx, bill(s, [{ variantId: await item(ctx), quantity: "1", unitPricePaise: 100 }])))).toBe("REGISTRATION_NOT_SET");
  });

  it("the weighted average includes earlier stock", async () => {
    const ctx = await newShop("Purchase average");
    const s = await setup(ctx);
    const shirt = await item(ctx);
    await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId: s.branchId, lines: [{ variantId: shirt, quantity: "2", unitCostPaise: 1000 }] });
    await createPurchase(ctx, bill(s, [{ variantId: shirt, quantity: "1", unitPricePaise: 2000 }]));
    expect(await level(ctx, shirt)).toMatchObject({ quantity: "3.000", averageCostPaise: "1333.3333" });
  });

  it("checks the input", async () => {
    const ctx = await newShop("Purchase checks");
    const s = await setup(ctx);
    const shirt = await item(ctx);
    const one = [{ variantId: shirt, quantity: "1", unitPricePaise: 100 }];
    expect(await codeOf(createPurchase(ctx, bill(s, one, { invoiceDate: "2099-01-01" })))).toBe("DATE_IN_FUTURE");
    expect(await codeOf(createPurchase(ctx, bill(s, one, { invoiceDate: "2026-02-30" })))).toBe("INVALID:invoiceDate");
    expect(await codeOf(createPurchase(ctx, bill(s, one, { invoiceDate: "2016-12-31" })))).toBe("INVALID:invoiceDate");
    expect(await codeOf(createPurchase(ctx, bill(s, []))) ).toBe("INVALID:lines");
    expect(await codeOf(createPurchase(ctx, bill(s, [{ variantId: shirt, quantity: "0", unitPricePaise: 100 }])))).toBe("ZERO_QUANTITY");
    expect(await codeOf(createPurchase(ctx, bill(s, [{ variantId: shirt, quantity: "1.5", unitPricePaise: 100 }])))).toBe("WHOLE_UNITS_ONLY");
    expect(await codeOf(createPurchase(ctx, bill(s, [{ variantId: shirt, quantity: "1", unitPricePaise: 1.5 }])))).toBe("INVALID:lines.0.unitPricePaise");
    expect(await codeOf(createPurchase(ctx, bill(s, [{ variantId: shirt, quantity: "1", unitPricePaise: 100, taxRate: "101" }])))).toBe("INVALID:lines.0.taxRate");
    expect(await codeOf(createPurchase(ctx, bill(s, one, { supplierInvoiceNumber: "<script>" })))).toBe("INVALID:supplierInvoiceNumber");
    expect(await codeOf(createPurchase(ctx, bill(s, one, { tenantId: randomUUID() })))).toBe("INVALID:");
    expect(await codeOf(createPurchase(ctx, bill(s, one, { payment: { amountPaise: 119, method: "cash", reference: "" } })))).toBe("PAYMENT_ABOVE_TOTAL");
    expect(await codeOf(createPurchase(ctx, bill(s, one, { payment: { amountPaise: 118, method: "gold", reference: "" } })))).toBe("INVALID:payment.method");
    // Metres take decimals.
    const cloth = await item(ctx, { unit: "m" });
    expect(await codeOf(createPurchase(ctx, bill(s, [{ variantId: cloth, quantity: "2.5", unitPricePaise: 4000, taxRate: "5" }])))).toBe("ok");
    expect(await level(ctx, cloth)).toMatchObject({ quantity: "2.500", averageCostPaise: "4000.0000" });
    expect(await level(ctx, shirt)).toMatchObject({ quantity: "0.000" });
  });

  it("free goods (total zero) post stock without a supplier entry", async () => {
    const ctx = await newShop("Purchase free");
    const s = await setup(ctx);
    const shirt = await item(ctx);
    await createPurchase(ctx, bill(s, [{ variantId: shirt, quantity: "4", unitPricePaise: 0 }]));
    expect(await level(ctx, shirt)).toMatchObject({ quantity: "4.000", averageCostPaise: "0.0000" });
    expect(await balanceOf(ctx, s.supplierId)).toBe(0);
  });
});

describe("duplicate supplier bills", () => {
  it("the same bill number for the same supplier is refused (any case); fine for another supplier", async () => {
    const ctx = await newShop("Purchase duplicate");
    const s = await setup(ctx);
    const other = await setup(ctx);
    const shirt = await item(ctx);
    const line = [{ variantId: shirt, quantity: "1", unitPricePaise: 100 }];
    await createPurchase(ctx, bill(s, line, { supplierInvoiceNumber: "INV/26/001" }));
    expect(await codeOf(createPurchase(ctx, bill(s, line, { supplierInvoiceNumber: "inv/26/001" })))).toBe("DUPLICATE_BILL");
    expect(await codeOf(createPurchase(ctx, bill(other, line, { supplierInvoiceNumber: "INV/26/001" })))).toBe("ok");
    expect(await level(ctx, shirt)).toMatchObject({ quantity: "2.000" });
  });

  it("two people entering the same bill at the same moment: exactly one is posted", async () => {
    const ctx = await newShop("Purchase race");
    const s = await setup(ctx);
    const shirt = await item(ctx);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => codeOf(createPurchase(ctx, bill(s, [{ variantId: shirt, quantity: "1", unitPricePaise: 100 }], { supplierInvoiceNumber: "RACE-1" })))),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r !== "ok").every((r) => r === "DUPLICATE_BILL")).toBe(true);
    expect(await level(ctx, shirt)).toMatchObject({ quantity: "1.000" });
    expect(await balanceOf(ctx, s.supplierId)).toBe(118);
  }, 90_000);
});

describe("paying suppliers", () => {
  it("paid with the bill, then the rest later; retries pay once", async () => {
    const ctx = await newShop("Purchase pay");
    const s = await setup(ctx);
    const shirt = await item(ctx);
    const { purchaseId } = await createPurchase(
      ctx,
      bill(s, [{ variantId: shirt, quantity: "10", unitPricePaise: 10_000 }], { payment: { amountPaise: 50_000, method: "upi", reference: "UTR123" } }),
    );
    expect(await getPurchase(ctx, { purchaseId })).toMatchObject({ totalPaise: 118_000, paidPaise: 50_000 });
    expect(await balanceOf(ctx, s.supplierId)).toBe(68_000);

    const payment = { idempotencyKey: randomUUID(), supplierId: s.supplierId, paidOn: "2026-09-02", amountPaise: 68_000, method: "bank", reference: "NEFT 9" };
    const first = await recordSupplierPayment(ctx, payment);
    expect(await recordSupplierPayment(ctx, payment)).toEqual(first);
    expect(await balanceOf(ctx, s.supplierId)).toBe(0);
    const entries = (await getSupplierStatement(ctx, { supplierId: s.supplierId })).entries.map((e) => [e.entryType, e.amountPaise]);
    expect(entries.sort()).toEqual([["payment", -50_000], ["payment", -68_000], ["purchase", 118_000]].sort());

    // Paying more than owed leaves an advance (negative balance).
    await recordSupplierPayment(ctx, { ...payment, idempotencyKey: randomUUID(), amountPaise: 5000 });
    expect(await balanceOf(ctx, s.supplierId)).toBe(-5000);
    expect(await codeOf(recordSupplierPayment(ctx, { ...payment, idempotencyKey: randomUUID(), paidOn: "2099-01-01" }))).toBe("DATE_IN_FUTURE");
    expect(await codeOf(recordSupplierPayment(ctx, { ...payment, idempotencyKey: randomUUID(), amountPaise: 0 }))).toBe("INVALID:amountPaise");
  });

  it("an archived supplier can be paid but not bought from", async () => {
    const ctx = await newShop("Purchase archived");
    const s = await setup(ctx);
    const shirt = await item(ctx);
    await createPurchase(ctx, bill(s, [{ variantId: shirt, quantity: "1", unitPricePaise: 1000 }]));
    await setSupplierArchived(ctx, { id: s.supplierId, archived: true });
    expect(await codeOf(createPurchase(ctx, bill(s, [{ variantId: shirt, quantity: "1", unitPricePaise: 1000 }])))).toBe("ARCHIVED");
    await recordSupplierPayment(ctx, { idempotencyKey: randomUUID(), supplierId: s.supplierId, paidOn: "2026-09-02", amountPaise: 1180, method: "cash", reference: "" });
    expect((await listSuppliers(ctx, { includeArchived: true }))[0]?.balancePaise).toBe(0);
  });
});

describe("voiding a purchase", () => {
  it("reverses stock, cost and the supplier's account; money paid stays as an advance; the bill number can be used again", async () => {
    const ctx = await newShop("Purchase void");
    const s = await setup(ctx);
    const shirt = await item(ctx);
    await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId: s.branchId, lines: [{ variantId: shirt, quantity: "2", unitCostPaise: 1000 }] });
    const wrong = await createPurchase(
      ctx,
      bill(s, [{ variantId: shirt, quantity: "1", unitPricePaise: 2000 }], { supplierInvoiceNumber: "V-1", payment: { amountPaise: 1000, method: "cash", reference: "" } }),
    );
    expect(await level(ctx, shirt)).toMatchObject({ quantity: "3.000", averageCostPaise: "1333.3333" });
    expect(await balanceOf(ctx, s.supplierId)).toBe(1360);

    const key = randomUUID();
    await voidPurchase(ctx, { idempotencyKey: key, purchaseId: wrong.purchaseId, reason: "Wrong price" });
    expect(await voidPurchase(ctx, { idempotencyKey: key, purchaseId: wrong.purchaseId, reason: "Wrong price" })).toEqual(wrong);
    expect(await codeOf(voidPurchase(ctx, { idempotencyKey: randomUUID(), purchaseId: wrong.purchaseId, reason: "Again" }))).toBe("ALREADY_VOIDED");

    expect(await level(ctx, shirt)).toMatchObject({ quantity: "2.000", averageCostPaise: "1000.0000" });
    expect(await balanceOf(ctx, s.supplierId)).toBe(-1000);
    expect(await getPurchase(ctx, wrong)).toMatchObject({ status: "voided", voidReason: "Wrong price", paidPaise: 1000 });
    const audit = await withTenant(ctx, (tx) => tx.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, wrong.purchaseId)));
    expect(audit.map((a) => a.action).sort()).toEqual(["purchases.created", "purchases.voided"]);

    // The corrected bill, same number; the advance pays part of it.
    await createPurchase(ctx, bill(s, [{ variantId: shirt, quantity: "1", unitPricePaise: 1500 }], { supplierInvoiceNumber: "V-1" }));
    expect(await balanceOf(ctx, s.supplierId)).toBe(770);
  });

  it("is refused, changing nothing, when some of that stock is gone", async () => {
    const ctx = await newShop("Purchase void sold");
    const s = await setup(ctx);
    const shirt = await item(ctx);
    const trouser = await item(ctx);
    const p = await createPurchase(ctx, bill(s, [
      { variantId: trouser, quantity: "2", unitPricePaise: 1000 },
      { variantId: shirt, quantity: "2", unitPricePaise: 1000 },
    ]));
    await adjustStock(ctx, { idempotencyKey: randomUUID(), branchId: s.branchId, variantId: shirt, direction: "out", quantity: "1", reasonCode: "damaged" });
    expect(await codeOf(voidPurchase(ctx, { idempotencyKey: randomUUID(), purchaseId: p.purchaseId, reason: "Wrong" }))).toBe("INSUFFICIENT_STOCK");
    expect(await level(ctx, trouser)).toMatchObject({ quantity: "2.000" });
    expect(await level(ctx, shirt)).toMatchObject({ quantity: "1.000" });
    expect(await getPurchase(ctx, p)).toMatchObject({ status: "posted" });
    expect(await balanceOf(ctx, s.supplierId)).toBe(4720);
  });

  it("a posted purchase cannot be edited or deleted, even directly", async () => {
    const ctx = await newShop("Purchase locked");
    const s = await setup(ctx);
    const p = await createPurchase(ctx, bill(s, [{ variantId: await item(ctx), quantity: "1", unitPricePaise: 1000 }]));
    await expect(withTenant(ctx, (tx) => tx.update(purchases).set({ totalPaise: 1 }).where(eq(purchases.id, p.purchaseId)))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.update(purchases).set({ note: "changed" }).where(eq(purchases.id, p.purchaseId)))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.delete(purchases).where(eq(purchases.id, p.purchaseId)))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.execute(sql`UPDATE purchase_items SET quantity = 5`))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.execute(sql`DELETE FROM supplier_payments`))).rejects.toThrow();
    // Once voided, nothing more can change.
    await voidPurchase(ctx, { idempotencyKey: randomUUID(), purchaseId: p.purchaseId, reason: "Test" });
    await expect(withTenant(ctx, (tx) => tx.update(purchases).set({ status: "posted", voidReason: null, voidedAt: null, voidedBy: null }).where(eq(purchases.id, p.purchaseId)))).rejects.toThrow();
    expect(await getPurchase(ctx, p)).toMatchObject({ status: "voided", totalPaise: 1180 });
  });
});

describe("IMEI items", () => {
  it("one number per unit; numbers already recorded are refused; a voided purchase's numbers can be entered again", async () => {
    const ctx = await newShop("Purchase IMEI", "registered", "mobile");
    const s = await setup(ctx);
    const phone = await item(ctx, { trackSerial: true });
    const imeis = ["356938035643801", "356938035643802"];
    expect(await codeOf(createPurchase(ctx, bill(s, [{ variantId: phone, quantity: "2", unitPricePaise: 1_000_000, serials: [imeis[0] ?? ""] }])))).toBe("SERIAL_COUNT");
    expect(await codeOf(createPurchase(ctx, bill(s, [{ variantId: phone, quantity: "2", unitPricePaise: 1_000_000 }])))).toBe("SERIAL_REQUIRED");
    const p = await createPurchase(ctx, bill(s, [{ variantId: phone, quantity: "2", unitPricePaise: 1_000_000, serials: imeis }]));
    expect(await level(ctx, phone)).toMatchObject({ quantity: "2.000" });
    expect(await codeOf(createPurchase(ctx, bill(s, [{ variantId: phone, quantity: "1", unitPricePaise: 1_000_000, serials: [imeis[1] ?? ""] }])))).toBe("SERIAL_TAKEN");

    await voidPurchase(ctx, { idempotencyKey: randomUUID(), purchaseId: p.purchaseId, reason: "Wrong model" });
    expect(await level(ctx, phone)).toMatchObject({ quantity: "0.000" });
    const statuses = await withTenant(ctx, (tx) => tx.select({ status: serialNumbers.status }).from(serialNumbers));
    expect(statuses).toEqual([{ status: "voided" }, { status: "voided" }]);

    const again = await createPurchase(ctx, bill(s, [{ variantId: phone, quantity: "2", unitPricePaise: 900_000, serials: imeis }]));
    expect(await level(ctx, phone)).toMatchObject({ quantity: "2.000", averageCostPaise: "900000.0000" });
    const rows = await withTenant(ctx, (tx) => tx.select({ status: serialNumbers.status, item: serialNumbers.purchaseItemId }).from(serialNumbers));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "in_stock" && r.item !== null)).toBe(true);
    expect((await getPurchase(ctx, again)).items[0]?.quantity).toBe("2.000");
  });

  it("a voided purchase whose phone was scrapped cannot be voided", async () => {
    const ctx = await newShop("Purchase IMEI scrapped", "registered", "mobile");
    const s = await setup(ctx);
    const phone = await item(ctx, { trackSerial: true });
    const p = await createPurchase(ctx, bill(s, [{ variantId: phone, quantity: "2", unitPricePaise: 1000, serials: ["IMEI-A-0001", "IMEI-A-0002"] }]));
    await adjustStock(ctx, { idempotencyKey: randomUUID(), branchId: s.branchId, variantId: phone, direction: "out", quantity: "1", reasonCode: "damaged", serial: "IMEI-A-0002" });
    expect(await codeOf(voidPurchase(ctx, { idempotencyKey: randomUUID(), purchaseId: p.purchaseId, reason: "Wrong" }))).toBe("INSUFFICIENT_STOCK");
    expect(await level(ctx, phone)).toMatchObject({ quantity: "1.000" });
  });
});

describe("all or nothing", () => {
  it("a failure on the last line leaves no bill, stock, account entry or used key", async () => {
    const ctx = await newShop("Purchase rollback", "registered", "mobile");
    const s = await setup(ctx);
    const phone = await item(ctx, { trackSerial: true });
    await createPurchase(ctx, bill(s, [{ variantId: phone, quantity: "1", unitPricePaise: 1000, serials: ["TAKEN-0001"] }]));
    const charger = await item(ctx);
    const input = bill(s, [
      { variantId: charger, quantity: "5", unitPricePaise: 1000 },
      { variantId: phone, quantity: "1", unitPricePaise: 1000, serials: ["TAKEN-0001"] },
    ], { payment: { amountPaise: 1000, method: "cash", reference: "" } });
    expect(await codeOf(createPurchase(ctx, input))).toBe("SERIAL_TAKEN");
    expect(await level(ctx, charger)).toMatchObject({ quantity: "0.000" });
    expect(await listPurchases(ctx)).toHaveLength(1);
    expect(await balanceOf(ctx, s.supplierId)).toBe(1180);

    // Fixed and sent again with the SAME key: it posts (the key was not used up).
    const fixed = { ...input, lines: [input.lines[0], { ...input.lines[1], serials: ["FRESH-0001"] }] };
    expect(await codeOf(createPurchase(ctx, fixed))).toBe("ok");
    expect(await level(ctx, charger)).toMatchObject({ quantity: "5.000" });
    expect(await balanceOf(ctx, s.supplierId)).toBe(1180 + 7080 - 1000);
  });
});

describe("who may buy and void", () => {
  it("a cashier may not buy or see purchases; an accountant may see but not buy; voiding needs 'Void a posted invoice' too", async () => {
    const owner = await newShop("Purchase roles");
    const s = await setup(owner);
    const shirt = await item(owner);
    const p = await createPurchase(owner, bill(s, [{ variantId: shirt, quantity: "1", unitPricePaise: 1000 }]));
    const cashier = await memberWithRole(owner, "Cashier");
    expect(await codeOf(createPurchase(cashier, bill(s, [{ variantId: shirt, quantity: "1", unitPricePaise: 1000 }])))).toBe("FORBIDDEN");
    expect(await codeOf(listPurchases(cashier))).toBe("FORBIDDEN");
    expect(await codeOf(recordSupplierPayment(cashier, { idempotencyKey: randomUUID(), supplierId: s.supplierId, paidOn: "2026-09-02", amountPaise: 100, method: "cash", reference: "" }))).toBe("FORBIDDEN");
    const accountant = await memberWithRole(owner, "Accountant");
    expect(await listPurchases(accountant)).toHaveLength(1);
    expect((await getPurchase(accountant, p)).items[0]?.unitCostPaise).toBe("1000.0000");
    expect(await codeOf(voidPurchase(accountant, { idempotencyKey: randomUUID(), purchaseId: p.purchaseId, reason: "No" }))).toBe("FORBIDDEN");

    // A custom role that may buy but not void, and cannot see cost.
    const buyer = await memberWithRole(owner, "Cashier");
    await withTenant(owner, async (tx) => {
      await tx.execute(sql`INSERT INTO roles (tenant_id, name) VALUES (${owner.tenantId}, 'Buyer')`);
      await tx.execute(sql`INSERT INTO role_permissions (tenant_id, role_id, permission_code) SELECT ${owner.tenantId}, id, 'purchases.create' FROM roles WHERE name = 'Buyer'`);
      await tx.execute(sql`UPDATE memberships SET role_id = (SELECT id FROM roles WHERE name = 'Buyer') WHERE user_id = ${buyer.userId}`);
    });
    expect(await codeOf(voidPurchase(buyer, { idempotencyKey: randomUUID(), purchaseId: p.purchaseId, reason: "No" }))).toBe("FORBIDDEN");
    expect((await getPurchase(buyer, p)).items[0]?.unitCostPaise).toBeUndefined();
  });
});

describe("another business", () => {
  it("cannot buy from, pay, see or void another business's suppliers and purchases", async () => {
    const a = await newShop("Purchase A");
    const b = await newShop("Purchase B");
    const sb = await setup(b);
    const bShirt = await item(b);
    const pb = await createPurchase(b, bill(sb, [{ variantId: bShirt, quantity: "3", unitPricePaise: 1000 }]));
    const sa = await setup(a);
    const aShirt = await item(a);
    expect(await codeOf(createPurchase(a, bill({ ...sa, supplierId: sb.supplierId }, [{ variantId: aShirt, quantity: "1", unitPricePaise: 1 }])))).toBe("NOT_FOUND");
    expect(await codeOf(createPurchase(a, bill(sa, [{ variantId: bShirt, quantity: "1", unitPricePaise: 1 }])))).toBe("VARIANT_NOT_FOUND");
    expect(await codeOf(createPurchase(a, bill({ ...sa, branchId: sb.branchId }, [{ variantId: aShirt, quantity: "1", unitPricePaise: 1 }])))).toBe("BRANCH_CLOSED");
    expect(await codeOf(recordSupplierPayment(a, { idempotencyKey: randomUUID(), supplierId: sb.supplierId, paidOn: "2026-09-02", amountPaise: 100, method: "cash", reference: "" }))).toBe("NOT_FOUND");
    expect(await codeOf(voidPurchase(a, { idempotencyKey: randomUUID(), purchaseId: pb.purchaseId, reason: "Attack" }))).toBe("NOT_FOUND");
    expect(await codeOf(getPurchase(a, pb))).toBe("NOT_FOUND");
    expect(await listPurchases(a)).toEqual([]);
    expect(await withTenant(a, (tx) => tx.select().from(partyLedgerEntries))).toEqual([]);
    expect(await getPurchase(b, pb)).toMatchObject({ status: "posted", totalPaise: 3540 });
    expect(await level(b, bShirt)).toMatchObject({ quantity: "3.000" });
  });
});
