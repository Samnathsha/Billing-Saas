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
import { adjustStock, getStockLevels, InventoryError, StockError } from "@/modules/inventory";
import { createSupplier, getSupplierStatement, PartyError } from "@/modules/parties";
import { createPurchase, createPurchaseReturn, getPurchaseReturnable, PurchaseError, voidPurchase } from "@/modules/purchasing";
import { gstinCheckChar } from "@/modules/tax/gst";
import { listBranches } from "@/modules/tenants";
import { registerVerifiedUser } from "../helpers/auth";

// Goods back to the supplier: amounts reverse the purchase exactly, never
// more than bought, stock out (never below zero), IMEIs from that line, the
// supplier balance, no void afterwards, who may, other businesses.

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

async function setup(ctx: TenantContext, opts: { trackSerial?: boolean } = {}) {
  const lists = await getCatalogLists(ctx);
  const product = await createProduct(ctx, {
    name: `Item ${randomUUID().slice(0, 6)}`,
    unitId: lists.units.find((u) => u.code === "pcs")?.id ?? "",
    taxCategory: "test_5",
    trackSerial: opts.trackSerial ?? false,
    ...(lists.template === "mobile" ? { attributes: { model: "M1" } } : {}),
    variants: [{ sku: `S-${randomUUID().slice(0, 8)}`, sellingPricePaise: 100_000 }],
  });
  const branchId = (await listBranches(ctx))[0]?.id ?? "";
  const { id: supplierId } = await createSupplier(ctx, { name: `Supplier ${randomUUID().slice(0, 6)}`, phone: "", gstin: "", stateCode: "33" });
  return { variantId: product.variants[0]?.id ?? "", branchId, supplierId };
}

// 10 at ₹50 + 5% GST = ₹525.00 (or IMEI phones).
async function bought(ctx: TenantContext, s: { variantId: string; branchId: string; supplierId: string }, extra: { serials?: string[]; payment?: unknown } = {}) {
  const quantity = extra.serials === undefined ? "10" : String(extra.serials.length);
  const { purchaseId } = await createPurchase(ctx, {
    idempotencyKey: randomUUID(),
    supplierId: s.supplierId,
    branchId: s.branchId,
    supplierInvoiceNumber: `P-${randomUUID().slice(0, 6)}`,
    invoiceDate: "2026-09-01",
    lines: [{ variantId: s.variantId, quantity, unitPricePaise: 5000, taxRate: "5", serials: extra.serials ?? [] }],
    ...(extra.payment === undefined ? {} : { payment: extra.payment }),
  });
  const lineId = (await getPurchaseReturnable(ctx, { purchaseId })).lines[0]?.purchaseItemId ?? "";
  return { purchaseId, lineId };
}

const goBack = (p: { purchaseId: string; lineId: string }, quantity: string, serials: string[] = []) => ({
  idempotencyKey: randomUUID(),
  purchaseId: p.purchaseId,
  reason: "Damaged in transit",
  reference: "DN-7",
  lines: [{ purchaseItemId: p.lineId, quantity, serials }],
});

const level = async (ctx: TenantContext, variantId: string) => (await getStockLevels(ctx, { variantIds: [variantId] }))[0]?.quantity ?? "0.000";
const balance = async (ctx: TenantContext, supplierId: string) => (await getSupplierStatement(ctx, { supplierId })).supplier.balancePaise;

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof PurchaseError || error instanceof StockError || error instanceof InventoryError || error instanceof PartyError || error instanceof PermissionDeniedError) return error.code;
    if (error instanceof ZodError) return `INVALID:${error.issues.map((i) => i.path.join(".")).join(",")}`;
    throw error;
  }
}

describe("returns to suppliers", () => {
  it("4 of 10 back: we owe ₹210 less; stock goes out; a retry saves once; audited", async () => {
    const ctx = await newShop("PR part");
    const s = await setup(ctx);
    const p = await bought(ctx, s);
    expect(await balance(ctx, s.supplierId)).toBe(52_500);
    const input = goBack(p, "4");
    const first = await createPurchaseReturn(ctx, input);
    expect(await createPurchaseReturn(ctx, input)).toEqual(first);
    expect(await balance(ctx, s.supplierId)).toBe(31_500);
    expect(await level(ctx, s.variantId)).toBe("6.000");
    const after = await getPurchaseReturnable(ctx, { purchaseId: p.purchaseId });
    expect(after.lines[0]).toMatchObject({ quantity: "10.000", returned: "4.000", remaining: "6.000" });
    expect(after.returns).toEqual([expect.objectContaining({ totalPaise: 21_000, reference: "DN-7" })]);
    const audit = await withTenant(ctx, (tx) => tx.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, first.purchaseReturnId)));
    expect(audit).toEqual([{ action: "purchases.returned" }]);
  });

  it("returns add up exactly to the purchase; then nothing more can go back", async () => {
    const ctx = await newShop("PR all");
    const s = await setup(ctx);
    const p = await bought(ctx, s);
    await createPurchaseReturn(ctx, goBack(p, "3"));
    await createPurchaseReturn(ctx, goBack(p, "7"));
    expect(await balance(ctx, s.supplierId)).toBe(0);
    expect(await level(ctx, s.variantId)).toBe("0.000");
    expect(await codeOf(createPurchaseReturn(ctx, goBack(p, "1")))).toBe("RETURN_TOO_MANY");
    expect(await codeOf(createPurchaseReturn(ctx, goBack({ ...p, lineId: randomUUID() }, "1")))).toBe("NOT_FOUND");
  });

  it("stock already sold or gone cannot go back; nothing changes", async () => {
    const ctx = await newShop("PR gone");
    const s = await setup(ctx);
    const p = await bought(ctx, s);
    await adjustStock(ctx, { idempotencyKey: randomUUID(), branchId: s.branchId, variantId: s.variantId, direction: "out", quantity: "8", reasonCode: "lost" });
    expect(await codeOf(createPurchaseReturn(ctx, goBack(p, "3")))).toBe("INSUFFICIENT_STOCK");
    expect(await balance(ctx, s.supplierId)).toBe(52_500);
    expect((await getPurchaseReturnable(ctx, { purchaseId: p.purchaseId })).returns).toEqual([]);
  });

  it("an already paid purchase: the supplier then owes us", async () => {
    const ctx = await newShop("PR paid");
    const s = await setup(ctx);
    const p = await bought(ctx, s, { payment: { amountPaise: 52_500, method: "cash", reference: "" } });
    await createPurchaseReturn(ctx, goBack(p, "2"));
    expect(await balance(ctx, s.supplierId)).toBe(-10_500);
  });

  it("IMEI phones: only ones from that line and still here; marked returned", async () => {
    const ctx = await newShop("PR IMEI", "mobile");
    const s = await setup(ctx, { trackSerial: true });
    const p = await bought(ctx, s, { serials: ["PR-IMEI-0001", "PR-IMEI-0002", "PR-IMEI-0003"] });
    expect((await getPurchaseReturnable(ctx, { purchaseId: p.purchaseId })).lines[0]?.serialsInStock).toEqual(["PR-IMEI-0001", "PR-IMEI-0002", "PR-IMEI-0003"]);
    expect(await codeOf(createPurchaseReturn(ctx, goBack(p, "1", ["NOT-FROM-HERE"])))).toBe("SERIAL_NOT_IN_STOCK");
    expect(await codeOf(createPurchaseReturn(ctx, goBack(p, "2", ["PR-IMEI-0001"])))).toBe("SERIAL_COUNT");
    expect(await codeOf(createPurchaseReturn(ctx, goBack(p, "1")))).toBe("SERIAL_REQUIRED");
    await createPurchaseReturn(ctx, goBack(p, "1", ["pr-imei-0002"]));
    const [row] = await withTenant(ctx, (tx) => tx.select({ status: serialNumbers.status }).from(serialNumbers).where(eq(serialNumbers.serial, "PR-IMEI-0002")));
    expect(row?.status).toBe("returned");
    expect(await level(ctx, s.variantId)).toBe("2.000");
    expect((await getPurchaseReturnable(ctx, { purchaseId: p.purchaseId })).lines[0]?.serialsInStock).toEqual(["PR-IMEI-0001", "PR-IMEI-0003"]);
  });

  it("a purchase with returns cannot be voided; a voided purchase takes no returns; rows cannot change", async () => {
    const ctx = await newShop("PR void");
    const s = await setup(ctx);
    const a = await bought(ctx, s);
    await createPurchaseReturn(ctx, goBack(a, "1"));
    expect(await codeOf(voidPurchase(ctx, { idempotencyKey: randomUUID(), purchaseId: a.purchaseId, reason: "Try" }))).toBe("RETURNS_EXIST");
    const b = await bought(ctx, s);
    await voidPurchase(ctx, { idempotencyKey: randomUUID(), purchaseId: b.purchaseId, reason: "Wrong" });
    expect(await codeOf(createPurchaseReturn(ctx, goBack(b, "1")))).toBe("ALREADY_VOIDED");
    await expect(withTenant(ctx, (tx) => tx.execute(sql`UPDATE purchase_returns SET total_paise = 1`))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.execute(sql`DELETE FROM purchase_return_items`))).rejects.toThrow();
  });
});

describe("who may, and another business", () => {
  it("a cashier may not send goods back; another business cannot touch this one's purchases", async () => {
    const owner = await newShop("PR roles");
    const s = await setup(owner);
    const p = await bought(owner, s);
    const user = await registerVerifiedUser("PR Cashier");
    await withTenant(owner, async (tx) => {
      const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, "Cashier"));
      await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
    });
    const cashier = await getRequestContext(user.headers);
    if (cashier.kind !== "member") throw new Error("member");
    expect(await codeOf(createPurchaseReturn(cashier.ctx, goBack(p, "1")))).toBe("FORBIDDEN");
    const other = await newShop("PR other");
    expect(await codeOf(createPurchaseReturn(other, goBack(p, "1")))).toBe("NOT_FOUND");
    expect(await codeOf(getPurchaseReturnable(other, { purchaseId: p.purchaseId }))).toBe("NOT_FOUND");
    expect(await level(owner, s.variantId)).toBe("10.000");
  });
});
