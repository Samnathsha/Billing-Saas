import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auditLogs, creditNotes, devices, invoices, memberships, roles, settings, syncFlags, syncOperations } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { makeOfflineReturn, makeOfflineSale, type OfflineCartLine } from "@/lib/offline-bill";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { changeVariantPrice, createProduct, getCatalogLists, getProduct, setProductArchived } from "@/modules/catalog";
import { adjustStock, getStockLevels, InventoryError, recordOpeningStock, StockError } from "@/modules/inventory";
import { PlanLimitError } from "@/modules/plans";
import { applyOfflineOperation, createReturn, createSale, getInvoice, getTillSnapshot, SalesError, type TillSnapshotDto } from "@/modules/sales";
import { listSyncFlags, listTills, registerTill, resolveSyncFlag, revokeTill, setOfflineWindowHours, TillError } from "@/modules/sync";
import { gstinCheckChar } from "@/modules/tax/gst";
import { listBranches, SettingsError, updateBusinessProfile, getBusinessProfile } from "@/modules/tenants";
import { registerVerifiedUser } from "../helpers/auth";

// Offline tills, server side (decision 0006; blueprint 8; business rules
// 17): registering and revoking tills, the till's offline copy, offline
// bills and returns applied exactly once, the late checks that keep a sale
// and flag it, the refusals, two tills selling one IMEI, and flags.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

const gstin = (state: string) => {
  const first14 = `${state}ABCDE1234F1Z`;
  return first14 + gstinCheckChar(first14);
};

async function newShop(label: string, template: "clothing" | "mobile" = "clothing"): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template });
  const r = await getRequestContext(owner.headers);
  if (r.kind !== "member") throw new Error("expected a member");
  await withTenant(r.ctx, (tx) => tx.update(settings).set({ gstRegistration: "registered", gstin: gstin("33"), stateCode: "33" }));
  return r.ctx;
}

async function memberWithRole(owner: TenantContext, role: string): Promise<TenantContext> {
  const user = await registerVerifiedUser(`Offline ${role}`);
  await withTenant(owner, async (tx) => {
    const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
    await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
  });
  const result = await getRequestContext(user.headers);
  if (result.kind !== "member") throw new Error("member");
  return result.ctx;
}

async function setRole(owner: TenantContext, userId: string, role: string): Promise<void> {
  await withTenant(owner, async (tx) => {
    const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
    await tx.update(memberships).set({ roleId: r?.id ?? "" }).where(eq(memberships.userId, userId));
  });
}

const mainBranch = async (ctx: TenantContext) => (await listBranches(ctx))[0]?.id ?? "";

async function stocked(ctx: TenantContext, stock: string, opts: { price?: number; trackSerial?: boolean; serials?: string[] } = {}) {
  const lists = await getCatalogLists(ctx);
  const product = await createProduct(ctx, {
    name: `Item ${randomUUID().slice(0, 6)}`,
    unitId: lists.units.find((u) => u.code === "pcs")?.id ?? "",
    taxCategory: "test_5",
    hsnCode: "6205",
    trackSerial: opts.trackSerial ?? false,
    ...(lists.template === "mobile" ? { attributes: { model: "M1" } } : {}),
    variants: [{ sku: `S-${randomUUID().slice(0, 8)}`, sellingPricePaise: opts.price ?? 79_900, costPricePaise: 45_000 }],
  });
  const branchId = await mainBranch(ctx);
  const variantId = product.variants[0]?.id ?? "";
  if (stock !== "0") await recordOpeningStock(ctx, { idempotencyKey: randomUUID(), branchId, lines: [{ variantId, quantity: stock, serials: opts.serials ?? [] }] });
  return { variantId, productId: product.id, branchId };
}

const level = async (ctx: TenantContext, variantId: string) => (await getStockLevels(ctx, { variantIds: [variantId] }))[0];

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof SalesError || error instanceof TillError || error instanceof StockError || error instanceof InventoryError || error instanceof PermissionDeniedError || error instanceof SettingsError || error instanceof PlanLimitError) return error.code;
    if (error instanceof ZodError) return "INVALID";
    throw error;
  }
}

async function till(ctx: TenantContext, prefix: string) {
  const registered = await registerTill(ctx, { name: `Counter ${prefix}`, branchId: await mainBranch(ctx), prefix });
  const snapshot = await getTillSnapshot(ctx, registered.token);
  return { ...registered, snapshot };
}

// A till's offline bill, made with the till's own code (src/lib/offline-bill).
function offlineSale(
  snapshot: TillSnapshotDto,
  madeBy: string,
  sequence: number,
  lines: { variantId: string; quantity?: string; discountPaise?: number; serial?: string; pricePaise?: number }[],
  opts: { at?: Date; billDiscountPaise?: number; pay?: number } = {},
) {
  const cart: OfflineCartLine[] = lines.map((l) => {
    const item = snapshot.items.find((i) => i.variantId === l.variantId);
    if (item === undefined) throw new Error("item not in the till's copy");
    return { item: { ...item, pricePaise: l.pricePaise ?? item.pricePaise }, quantity: l.quantity ?? "1", discountPaise: l.discountPaise ?? 0, serial: l.serial ?? null };
  });
  const draft = makeOfflineSale({
    opId: randomUUID(),
    invoiceId: randomUUID(),
    lineIds: cart.map(() => randomUUID()),
    madeBy,
    at: opts.at ?? new Date(),
    settings: snapshot.settings,
    taxRates: snapshot.taxRates,
    prefix: snapshot.till.prefix,
    sequence,
    lines: cart,
    billDiscountPaise: opts.billDiscountPaise ?? 0,
    payments: [],
  });
  return { ...draft.op, payments: [{ method: "cash" as const, amountPaise: opts.pay ?? draft.bill.payablePaise, reference: null }] };
}

const flagsOf = async (ctx: TenantContext, invoiceId: string) =>
  (await withTenant(ctx, (tx) => tx.select({ code: syncFlags.code, detail: syncFlags.detail }).from(syncFlags).where(eq(syncFlags.invoiceId, invoiceId)))).map((f) => f.code).sort();

describe("registering tills", () => {
  it("a manager registers a till: its own prefix, a token shown once (only its hash kept), audited", async () => {
    const owner = await newShop("Till reg");
    const manager = await memberWithRole(owner, "Manager");
    const t = await registerTill(manager, { name: "Counter 1", branchId: await mainBranch(owner), prefix: "t1" });
    expect(t).toMatchObject({ name: "Counter 1", prefix: "T1" });
    expect(t.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await withTenant(owner, (tx) => tx.select({ tokenHash: devices.tokenHash, prefix: devices.prefix }).from(devices).where(eq(devices.id, t.tillId)));
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.tokenHash).not.toContain(t.token);
    expect((await listTills(owner)).map((x) => [x.name, x.prefix, x.status])).toEqual([["Counter 1", "T1", "active"]]);
    const [audit] = await withTenant(owner, (tx) => tx.select({ after: auditLogs.after }).from(auditLogs).where(eq(auditLogs.action, "tills.registered")));
    expect(JSON.stringify(audit?.after)).not.toContain(t.token);
  });

  it("a prefix may not clash with the business's series or another till's (credit notes use prefix + R)", async () => {
    const owner = await newShop("Till prefixes");
    const branchId = await mainBranch(owner);
    const reg = (prefix: string) => codeOf(registerTill(owner, { name: `Till ${prefix}`, branchId, prefix }));
    expect(await reg("CN")).toBe("PREFIX_TAKEN"); // the business's credit notes
    expect(await reg("A")).toBe("ok");
    expect(await reg("AR")).toBe("PREFIX_TAKEN"); // till A's credit notes
    expect(await reg("B")).toBe("ok");
    expect(await reg("B")).toBe("PREFIX_TAKEN");
    expect(await reg("ABCD")).toBe("INVALID");
    // And the other way round: the business cannot take a till's series.
    const p = await getBusinessProfile(owner);
    const editable = {
      businessName: p.businessName,
      addressLine1: p.addressLine1,
      addressLine2: p.addressLine2,
      city: p.city,
      stateCode: p.stateCode,
      pincode: p.pincode,
      phone: p.phone,
      contactEmail: p.contactEmail,
      gstRegistration: p.gstRegistration,
      gstin: p.gstin,
      pricesIncludeTax: p.pricesIncludeTax,
      invoicePrefix: p.invoicePrefix,
      creditNotePrefix: p.creditNotePrefix,
      version: p.version,
    };
    expect(await codeOf(updateBusinessProfile(owner, { ...editable, invoicePrefix: "BR" }))).toBe("PREFIX_USED_BY_TILL");
    expect(await codeOf(updateBusinessProfile(owner, { ...editable, invoicePrefix: "BILL" }))).toBe("ok");
  });

  it("only Manage tills may register or revoke; the plan's 5 tills; a revoked till is final and refused", async () => {
    const owner = await newShop("Till rights");
    const cashier = await memberWithRole(owner, "Cashier");
    const branchId = await mainBranch(owner);
    expect(await codeOf(registerTill(cashier, { name: "Mine", branchId, prefix: "X" }))).toBe("FORBIDDEN");
    const tills = [];
    for (const p of ["P1", "P2", "P3", "P4", "P5"]) tills.push(await registerTill(owner, { name: p, branchId, prefix: p }));
    expect(await codeOf(registerTill(owner, { name: "P6", branchId, prefix: "P6" }))).toBe("LIMIT_REACHED");
    const first = tills[0];
    if (first === undefined) throw new Error("till");
    expect(await codeOf(revokeTill(cashier, { tillId: first.tillId }))).toBe("FORBIDDEN");
    await revokeTill(owner, { tillId: first.tillId });
    expect(await codeOf(revokeTill(owner, { tillId: first.tillId }))).toBe("ALREADY_REVOKED");
    expect(await codeOf(getTillSnapshot(owner, first.token))).toBe("TILL_REVOKED");
    // The database keeps it revoked, even against a direct change.
    await expect(withTenant(owner, (tx) => tx.update(devices).set({ status: "active", revokedAt: null }).where(eq(devices.id, first.tillId)))).rejects.toThrow();
    // A revoked till no longer counts against the plan.
    expect(await codeOf(registerTill(owner, { name: "P6", branchId, prefix: "P6" }))).toBe("ok");
  });

  it("another business's token, or a made-up one, is not a till here", async () => {
    const a = await newShop("Till A");
    const b = await newShop("Till B");
    const tA = await registerTill(a, { name: "A1", branchId: await mainBranch(a), prefix: "A1" });
    expect(await codeOf(getTillSnapshot(b, tA.token))).toBe("TILL_UNKNOWN");
    expect(await codeOf(getTillSnapshot(a, "x".repeat(43)))).toBe("TILL_UNKNOWN");
    expect(await codeOf(getTillSnapshot(a, "not a token"))).toBe("TILL_UNKNOWN");
  });
});

describe("the till's offline copy", () => {
  it("items with selling price and rates, IMEIs in stock, the business details; never cost prices", async () => {
    const owner = await newShop("Snapshot", "mobile");
    const phone = await stocked(owner, "2", { trackSerial: true, serials: ["IMEI-SNAP-1", "IMEI-SNAP-2"], price: 1_500_000 });
    const t = await till(owner, "S1");
    const item = t.snapshot.items.find((i) => i.variantId === phone.variantId);
    expect(item).toMatchObject({ pricePaise: 1_500_000, trackSerial: true, taxCategory: "test_5" });
    expect(t.snapshot.taxRates.test_5?.length).toBeGreaterThan(0);
    expect(t.snapshot.serials.map((s) => s.serial).sort()).toEqual(["IMEI-SNAP-1", "IMEI-SNAP-2"]);
    expect(t.snapshot.settings).toMatchObject({ chargesGst: true, offlineWindowHours: 72, ready: true });
    expect(t.snapshot.till).toMatchObject({ prefix: "S1", creditNotePrefix: "S1R" });
    expect(JSON.stringify(t.snapshot).toLowerCase()).not.toContain("cost");
  });

  it("needs Create sale", async () => {
    const owner = await newShop("Snapshot rights");
    const accountant = await memberWithRole(owner, "Accountant");
    const t = await till(owner, "S2");
    expect(await codeOf(getTillSnapshot(accountant, t.token))).toBe("FORBIDDEN");
  });
});

describe("an offline bill reaching the server", () => {
  it("saved exactly as the till made it: the till's number, the seller, the till; stock out; sending it again changes nothing", async () => {
    const owner = await newShop("Offline sale");
    const cashier = await memberWithRole(owner, "Cashier");
    const shirt = await stocked(owner, "5");
    const t = await till(owner, "T1");
    const op = offlineSale(t.snapshot, cashier.userId, 1, [{ variantId: shirt.variantId, quantity: "2", discountPaise: 1_000 }]);

    const first = await applyOfflineOperation(cashier, t.token, op);
    expect(first).toMatchObject({ kind: "sale", id: op.invoiceId, number: op.number, flags: [], repeat: false });
    expect(op.number).toMatch(/^T1\/\d{2}-\d{2}\/00001$/);
    const bill = await getInvoice(owner, { invoiceId: op.invoiceId });
    // 2 x ₹799 - ₹10 = ₹1,588.00, all paid in cash.
    expect(bill).toMatchObject({ number: op.number, payablePaise: 158_800, paidPaise: 158_800, creditPaise: 0 });
    expect(bill.payablePaise).toBe(op.payablePaise);
    const [row] = await withTenant(owner, (tx) => tx.select().from(invoices).where(eq(invoices.id, op.invoiceId)));
    expect(row).toMatchObject({ deviceId: t.tillId, createdBy: cashier.userId, syncedBy: cashier.userId, prefix: "T1" });
    expect(row?.offlineAt?.toISOString()).toBe(op.madeAt);
    expect((await level(owner, shirt.variantId))?.quantity).toBe("3.000");

    // The answer was lost and the till sends it again: one bill, same answer.
    const again = await applyOfflineOperation(cashier, t.token, op);
    expect(again).toEqual({ ...first, repeat: true });
    expect((await level(owner, shirt.variantId))?.quantity).toBe("3.000");
    const ops = await withTenant(owner, (tx) => tx.select({ status: syncOperations.status }).from(syncOperations).where(eq(syncOperations.clientOpId, op.opId)));
    expect(ops).toEqual([{ status: "applied" }]);
    // The next bill continues the till's series; the copy knows the last number.
    expect((await getTillSnapshot(owner, t.token)).lastNumbers).toEqual([expect.objectContaining({ series: "invoice", last: 1 })]);
  });

  it("thirty bills sent at once in parallel and twice each: thirty bills, stock exact (blueprint Phase 10 done-when)", async () => {
    const owner = await newShop("Offline thirty");
    const shirt = await stocked(owner, "40");
    const t = await till(owner, "T3");
    const ops = Array.from({ length: 30 }, (_, i) => offlineSale(t.snapshot, owner.userId, i + 1, [{ variantId: shirt.variantId }]));
    // In order (as the till sends), then all again at once.
    for (const op of ops) await applyOfflineOperation(owner, t.token, op);
    const repeats = await Promise.all(ops.map((op) => applyOfflineOperation(owner, t.token, op)));
    expect(repeats.every((r) => r.repeat)).toBe(true);
    const count = await withTenant(owner, (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(invoices).where(eq(invoices.deviceId, t.tillId)));
    expect(count[0]?.n).toBe(30);
    expect((await level(owner, shirt.variantId))?.quantity).toBe("10.000");
  });

  it("stock short: the sale is kept, stock goes below zero, a manager is told; stock coming in later takes its own cost", async () => {
    const owner = await newShop("Offline short");
    const shirt = await stocked(owner, "1");
    const t = await till(owner, "T4");
    const op = offlineSale(t.snapshot, owner.userId, 1, [{ variantId: shirt.variantId, quantity: "3" }]);
    expect((await applyOfflineOperation(owner, t.token, op)).flags).toEqual(["stock_short"]);
    expect((await level(owner, shirt.variantId))?.quantity).toBe("-2.000");
    // Online selling still never goes below zero.
    expect(await codeOf(createSale(owner, { idempotencyKey: randomUUID(), invoiceId: randomUUID(), branchId: shirt.branchId, lines: [{ variantId: shirt.variantId, quantity: "1" }], payments: [{ method: "cash", amountPaise: 79_900 }] }))).toBe("INSUFFICIENT_STOCK");
    // Nor does anything else going out.
    expect(await codeOf(adjustStock(owner, { idempotencyKey: randomUUID(), branchId: shirt.branchId, variantId: shirt.variantId, direction: "out", quantity: "1", reasonCode: "lost" }))).toBe("INSUFFICIENT_STOCK");
    // Found stock comes in at the current average (₹450, the opening cost):
    // -2 + 5 = 3 at ₹450, not a mix that divides by a negative quantity.
    await adjustStock(owner, { idempotencyKey: randomUUID(), branchId: shirt.branchId, variantId: shirt.variantId, direction: "in", quantity: "5", reasonCode: "found" });
    expect(await level(owner, shirt.variantId)).toMatchObject({ quantity: "3.000", averageCostPaise: "45000.0000" });
  });

  it("a price changed, an item archived, a discount above a cashier's limit: kept as paid, each flagged", async () => {
    const owner = await newShop("Offline late");
    const cashier = await memberWithRole(owner, "Cashier");
    const a = await stocked(owner, "5");
    const b = await stocked(owner, "5");
    const t = await till(owner, "T5");
    // Meanwhile on the server: A's price goes up, B is archived.
    const variantA = (await getProduct(owner, a.productId)).variants[0];
    await changeVariantPrice(owner, { variantId: a.variantId, version: variantA?.version ?? 0, sellingPricePaise: 84_900, mrpPaise: null });
    await setProductArchived(owner, { id: b.productId, archived: true });
    // ₹100 off a ₹1,598 bill is above the 5% cashier limit (₹79.90).
    const op = offlineSale(t.snapshot, cashier.userId, 1, [{ variantId: a.variantId }, { variantId: b.variantId }], { billDiscountPaise: 10_000 });
    const result = await applyOfflineOperation(cashier, t.token, op);
    expect(result.flags.sort()).toEqual(["discount_over_limit", "item_archived", "price_changed"]);
    const bill = await getInvoice(owner, { invoiceId: op.invoiceId });
    expect(bill.items.map((i) => i.unitPricePaise)).toEqual([79_900, 79_900]);
    expect(bill.payablePaise).toBe(op.payablePaise);
    const flags = await listSyncFlags(owner, { status: "open" });
    expect(flags.find((f) => f.code === "price_changed")?.detail).toMatchObject({ paidPaise: 79_900, nowPaise: 84_900 });
    expect(flags.every((f) => f.document?.number === op.number && f.tillName === "Counter T5")).toBe(true);
  });

  it("the seller's role was removed meanwhile: kept, flagged, recorded as theirs, sent by a manager", async () => {
    const owner = await newShop("Offline role");
    const cashier = await memberWithRole(owner, "Cashier");
    const shirt = await stocked(owner, "5");
    const t = await till(owner, "T6");
    const op = offlineSale(t.snapshot, cashier.userId, 1, [{ variantId: shirt.variantId }]);
    await setRole(owner, cashier.userId, "Accountant");
    // They can no longer send it themselves...
    expect(await codeOf(applyOfflineOperation(cashier, t.token, op))).toBe("FORBIDDEN");
    // ...a manager logged in on that till does.
    expect((await applyOfflineOperation(owner, t.token, op)).flags).toEqual(["role_removed"]);
    const [row] = await withTenant(owner, (tx) => tx.select({ createdBy: invoices.createdBy, syncedBy: invoices.syncedBy }).from(invoices).where(eq(invoices.id, op.invoiceId)));
    expect(row).toEqual({ createdBy: cashier.userId, syncedBy: owner.userId });
  });

  it("two tills sell the same phone offline: the first to sync wins, the second is kept and flagged once", async () => {
    const owner = await newShop("Offline IMEI", "mobile");
    const phone = await stocked(owner, "1", { trackSerial: true, serials: ["IMEI-TWICE-1"], price: 1_500_000 });
    const t1 = await till(owner, "M1");
    const t2 = await till(owner, "M2");
    const op1 = offlineSale(t1.snapshot, owner.userId, 1, [{ variantId: phone.variantId, serial: "IMEI-TWICE-1" }]);
    const op2 = offlineSale(t2.snapshot, owner.userId, 1, [{ variantId: phone.variantId, serial: "IMEI-TWICE-1" }]);
    const [r1, r2] = await Promise.all([applyOfflineOperation(owner, t1.token, op1), applyOfflineOperation(owner, t2.token, op2)]);
    const flagged = [r1, r2].filter((r) => r.flags.includes("imei_unavailable"));
    expect(flagged).toHaveLength(1);
    const all = await withTenant(owner, (tx) => tx.select({ code: syncFlags.code }).from(syncFlags).where(eq(syncFlags.code, "imei_unavailable")));
    expect(all).toHaveLength(1);
    // Both phones left the shop: stock -1 (also flagged stock short).
    expect((await level(owner, phone.variantId))?.quantity).toBe("-1.000");
    const winner = flagged[0] === r1 ? op2 : op1;
    expect((await getInvoice(owner, { invoiceId: winner.invoiceId })).items[0]?.serial).toBe("IMEI-TWICE-1");
  });

  it("a gap in the till's numbers and a till clock in the future are kept and flagged", async () => {
    const owner = await newShop("Offline gap");
    const shirt = await stocked(owner, "5");
    const t = await till(owner, "T7");
    expect((await applyOfflineOperation(owner, t.token, offlineSale(t.snapshot, owner.userId, 1, [{ variantId: shirt.variantId }]))).flags).toEqual([]);
    expect((await applyOfflineOperation(owner, t.token, offlineSale(t.snapshot, owner.userId, 3, [{ variantId: shirt.variantId }]))).flags).toEqual(["number_gap"]);
    const future = new Date(Date.now() + 40 * 86_400_000);
    const op = offlineSale(t.snapshot, owner.userId, 4, [{ variantId: shirt.variantId }], { at: future });
    const result = await applyOfflineOperation(owner, t.token, op).catch((e: unknown) => e);
    // A month ahead may already be another financial year: either the date
    // is corrected (and flagged), or the number does not match the year.
    if (result instanceof SalesError) expect(result.code).toBe("OFFLINE_BAD_NUMBER");
    else expect((result as { flags: string[] }).flags).toEqual(["date_corrected"]);
  });

  it("refused (nothing saved): totals that do not add up, not fully paid, a wrong series, a number used twice, a rate the item never had, an unknown seller", async () => {
    const owner = await newShop("Offline refused");
    const other = await newShop("Offline stranger");
    const shirt = await stocked(owner, "5");
    const t = await till(owner, "T8");
    const ok = () => offlineSale(t.snapshot, owner.userId, 1, [{ variantId: shirt.variantId }]);
    const send = (op: unknown) => codeOf(applyOfflineOperation(owner, t.token, op));
    expect(await send({ ...ok(), payablePaise: 1 })).toBe("OFFLINE_TOTAL_MISMATCH");
    expect(await send(offlineSale(t.snapshot, owner.userId, 1, [{ variantId: shirt.variantId }], { pay: 50_000 }))).toBe("OFFLINE_NOT_FULLY_PAID");
    const wrongSeries = ok();
    expect(await send({ ...wrongSeries, number: wrongSeries.number.replace("T8/", "INV/") })).toBe("OFFLINE_BAD_NUMBER");
    const badRate = ok();
    expect(await send({ ...badRate, lines: badRate.lines.map((l) => ({ ...l, taxRate: "12" })) })).toBe("OFFLINE_BAD_RATE");
    expect(await send({ ...ok(), madeBy: other.userId })).toBe("OFFLINE_UNKNOWN_SELLER");
    expect(await send({ ...ok(), lines: [] })).toBe("INVALID");
    expect(await send({ ...ok(), tenantId: other.tenantId })).toBe("INVALID");
    expect((await level(owner, shirt.variantId))?.quantity).toBe("5.000");
    expect(await send(ok())).toBe("ok");
    expect(await send(ok())).toBe("OFFLINE_NUMBER_USED");
    expect((await level(owner, shirt.variantId))?.quantity).toBe("4.000");
  });

  it("a revoked till is refused at its next sync", async () => {
    const owner = await newShop("Offline revoked");
    const shirt = await stocked(owner, "5");
    const t = await till(owner, "T9");
    await revokeTill(owner, { tillId: t.tillId });
    expect(await codeOf(applyOfflineOperation(owner, t.token, offlineSale(t.snapshot, owner.userId, 1, [{ variantId: shirt.variantId }])))).toBe("TILL_REVOKED");
    expect((await level(owner, shirt.variantId))?.quantity).toBe("5.000");
  });
});

describe("an offline return", () => {
  async function soldOffline(label: string) {
    const owner = await newShop(label);
    const cashier = await memberWithRole(owner, "Cashier");
    const shirt = await stocked(owner, "5");
    const t = await till(owner, "R1");
    const sale = offlineSale(t.snapshot, cashier.userId, 1, [{ variantId: shirt.variantId, quantity: "2" }]);
    return { owner, cashier, shirt, t, sale };
  }

  const returnOf = (snapshot: TillSnapshotDto, madeBy: string, sequence: number, invoiceId: string, line: { invoiceItemId: string; sold: string; returned: string; taxablePaise: number; cgstPaise: number; igstPaise: number }, quantity: string) =>
    makeOfflineReturn({
      opId: randomUUID(),
      creditNoteId: randomUUID(),
      madeBy,
      at: new Date(),
      settings: snapshot.settings,
      prefix: snapshot.till.creditNotePrefix,
      sequence,
      invoiceId,
      lines: [{ line, quantity, resellable: true }],
      refundMethod: "cash",
      reason: "Wrong size",
    });

  it("of this till's bill: a credit note from the till's series, the refund the till gave, stock back; once", async () => {
    const { owner, cashier, shirt, t, sale } = await soldOffline("Offline return");
    await applyOfflineOperation(cashier, t.token, sale);
    const kept = (await getTillSnapshot(cashier, t.token)).recentBills.find((b) => b.invoiceId === sale.invoiceId);
    const line = kept?.lines[0];
    if (line === undefined) throw new Error("the bill should be on the till");
    expect(line).toMatchObject({ sold: "2.000", returned: "0.000" });
    const { op, refundPaise } = returnOf(t.snapshot, cashier.userId, 1, sale.invoiceId, line, "1");
    expect(refundPaise).toBe(79_900);
    const result = await applyOfflineOperation(cashier, t.token, op);
    expect(result).toMatchObject({ kind: "return", number: op.number, flags: [], repeat: false });
    expect(op.number).toMatch(/^R1R\/\d{2}-\d{2}\/00001$/);
    expect((await applyOfflineOperation(cashier, t.token, op)).repeat).toBe(true);
    const [cn] = await withTenant(owner, (tx) => tx.select().from(creditNotes).where(eq(creditNotes.id, op.creditNoteId)));
    expect(cn).toMatchObject({ refundPaise: 79_900, deviceId: t.tillId, createdBy: cashier.userId, refundMethod: "cash" });
    expect((await level(owner, shirt.variantId))?.quantity).toBe("4.000");
  });

  it("queued before its sale reached the server: told to wait (409), then applied after the sale", async () => {
    const { cashier, t, sale } = await soldOffline("Offline order");
    const line = { invoiceItemId: sale.lines[0]?.lineId ?? "", sold: "2.000", returned: "0.000", taxablePaise: 152_190, cgstPaise: 3_805, igstPaise: 0 };
    const { op } = returnOf(t.snapshot, cashier.userId, 1, sale.invoiceId, line, "2");
    expect(await codeOf(applyOfflineOperation(cashier, t.token, op))).toBe("OFFLINE_SALE_NOT_SYNCED");
    await applyOfflineOperation(cashier, t.token, sale);
    expect((await applyOfflineOperation(cashier, t.token, op)).flags).toEqual([]);
  });

  it("of a bill made elsewhere: refused (offline returns are for this till's bills only)", async () => {
    const { owner, cashier, shirt, t } = await soldOffline("Offline elsewhere");
    const invoiceId = randomUUID();
    await createSale(owner, { idempotencyKey: randomUUID(), invoiceId, branchId: shirt.branchId, lines: [{ variantId: shirt.variantId, quantity: "1" }], payments: [{ method: "cash", amountPaise: 79_900 }] });
    const item = (await getInvoice(owner, { invoiceId })).items[0];
    const [itemRow] = await withTenant(owner, (tx) => tx.execute<{ id: string }>(sql`SELECT id FROM invoice_items WHERE invoice_id = ${invoiceId}`)).then((r) => r.rows);
    expect(item).toBeDefined();
    const { op } = returnOf(t.snapshot, cashier.userId, 1, invoiceId, { invoiceItemId: itemRow?.id ?? "", sold: "1.000", returned: "0.000", taxablePaise: 76_095, cgstPaise: 1_902, igstPaise: 0 }, "1");
    expect(await codeOf(applyOfflineOperation(cashier, t.token, op))).toBe("OFFLINE_NOT_THIS_TILL");
  });

  it("more than was sold (another return happened online meanwhile): refused", async () => {
    const { owner, cashier, shirt, t, sale } = await soldOffline("Offline too many");
    await applyOfflineOperation(cashier, t.token, sale);
    const line = (await getTillSnapshot(cashier, t.token)).recentBills[0]?.lines[0];
    if (line === undefined) throw new Error("line");
    await createReturn(owner, { idempotencyKey: randomUUID(), creditNoteId: randomUUID(), invoiceId: sale.invoiceId, branchId: shirt.branchId, refundMethod: "cash", reason: "Online return", lines: [{ invoiceItemId: line.invoiceItemId, quantity: "2", resellable: true }] });
    const { op } = returnOf(t.snapshot, cashier.userId, 1, sale.invoiceId, line, "1");
    expect(await codeOf(applyOfflineOperation(cashier, t.token, op))).toBe("RETURN_TOO_MANY");
  });

  it("an online bill made on a registered till is also kept on it for returns", async () => {
    const owner = await newShop("Online on till");
    const shirt = await stocked(owner, "5");
    const t = await till(owner, "R2");
    const invoiceId = randomUUID();
    await createSale(owner, { idempotencyKey: randomUUID(), invoiceId, branchId: shirt.branchId, tillId: t.tillId, lines: [{ variantId: shirt.variantId, quantity: "1" }], payments: [{ method: "cash", amountPaise: 79_900 }] });
    expect((await getTillSnapshot(owner, t.token)).recentBills.map((b) => b.invoiceId)).toEqual([invoiceId]);
  });

  // Yesterday must be in the same financial year (not on 1 April).
  const yesterdaySameYear = new Date(Date.now() - 86_400_000).toISOString().slice(5, 10) !== "03-31";
  it.skipIf(!yesterdaySameYear)("after the return window, by someone who may not: kept and flagged", async () => {
    const { owner, cashier, t, sale } = await soldOffline("Offline window");
    // The till was registered days ago and the bill was made yesterday.
    await withTenant(owner, (tx) => tx.update(devices).set({ createdAt: new Date(Date.now() - 5 * 86_400_000) }).where(eq(devices.id, t.tillId)));
    const yesterday = new Date(Date.now() - 86_400_000);
    const old = offlineSale(t.snapshot, cashier.userId, 1, [{ variantId: sale.lines[0]?.variantId ?? "" }], { at: yesterday });
    expect((await applyOfflineOperation(cashier, t.token, old)).flags).toEqual([]);
    expect((await getInvoice(owner, { invoiceId: old.invoiceId })).invoiceDate).toBe(old.invoiceDate);
    // The till already keeps the bill; then the business shortens the window.
    const line = (await getTillSnapshot(owner, t.token)).recentBills.find((b) => b.invoiceId === old.invoiceId)?.lines[0];
    if (line === undefined) throw new Error("yesterday's bill should be kept on the till");
    await withTenant(owner, (tx) => tx.update(settings).set({ returnWindowDays: 0 }));
    const { op } = returnOf(t.snapshot, cashier.userId, 1, old.invoiceId, line, "1");
    expect((await applyOfflineOperation(cashier, t.token, op)).flags).toEqual(["return_after_window"]);
  });
});

describe("flags for a manager", () => {
  it("listed with the till and the bill; resolved once with a note; Manage tills only; never edited", async () => {
    const owner = await newShop("Flags");
    const cashier = await memberWithRole(owner, "Cashier");
    const shirt = await stocked(owner, "0");
    const t = await till(owner, "F1");
    const op = offlineSale(t.snapshot, owner.userId, 1, [{ variantId: shirt.variantId }]);
    await applyOfflineOperation(owner, t.token, op);
    expect(await flagsOf(owner, op.invoiceId)).toEqual(["stock_short"]);
    expect(await codeOf(listSyncFlags(cashier, {}))).toBe("FORBIDDEN");
    const [flag] = await listSyncFlags(owner, {});
    if (flag === undefined) throw new Error("flag");
    expect(await codeOf(resolveSyncFlag(cashier, { flagId: flag.id, note: "Counted" }))).toBe("FORBIDDEN");
    expect(await codeOf(resolveSyncFlag(owner, { flagId: flag.id, note: "x" }))).toBe("INVALID");
    await resolveSyncFlag(owner, { flagId: flag.id, note: "Counted the shelf; stock corrected" });
    expect(await codeOf(resolveSyncFlag(owner, { flagId: flag.id, note: "Again" }))).toBe("FLAG_RESOLVED");
    expect(await listSyncFlags(owner, {})).toEqual([]);
    expect((await listSyncFlags(owner, { status: "resolved" }))[0]).toMatchObject({ resolutionNote: "Counted the shelf; stock corrected" });
    await expect(withTenant(owner, (tx) => tx.update(syncFlags).set({ code: "price_changed" }).where(eq(syncFlags.id, flag.id)))).rejects.toThrow();
    await expect(withTenant(owner, (tx) => tx.delete(syncFlags).where(eq(syncFlags.id, flag.id)))).rejects.toThrow();
  });

  it("the offline window is a business setting (Owner and Admin)", async () => {
    const owner = await newShop("Window");
    const manager = await memberWithRole(owner, "Manager");
    expect(await codeOf(setOfflineWindowHours(manager, { hours: 24 }))).toBe("FORBIDDEN");
    expect(await codeOf(setOfflineWindowHours(owner, { hours: 0 }))).toBe("INVALID");
    await setOfflineWindowHours(owner, { hours: 24 });
    const t = await till(owner, "W1");
    expect(t.snapshot.settings.offlineWindowHours).toBe(24);
  });
});
