import "server-only";
import { z } from "zod";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { discountWithinLimit, quantityToMilli, rateToE4 } from "@/lib/bill-maths";
import { financialYearOfDay, parseDocumentNumber, tillCreditNotePrefix } from "@/lib/document-number";
import { catalogForTill, variantsForSale } from "@/modules/catalog";
import { belowZero, inStockSerialsAt, markSerialsSold, postMovements, takeSerialIfAvailable, unitCostsOf, type MovementInput } from "@/modules/inventory";
import type { ActiveTill } from "@/modules/sync";
import { pickTaxRate, taxRatesFor, type TaxRateRow } from "@/modules/tax";
import { SalesError } from "./errors";
import * as repo from "./repo";
import { milliText, planReturn, writeReturn } from "./return-core";
import { addMonths, bill, isUniqueViolation, sellerAddress, todayIn } from "./sale-core";

// Offline bills and returns reaching the server from a registered till
// (decision 0006; blueprint 8; business rules 17), inside the caller's
// transaction after the permission check, the till's token and the repeat
// check. The server is the authority:
// - REFUSED (nothing saved; the till lists it as failed): what cannot be a
//   correct record at all: a number outside the till's series or already
//   used, totals that do not add up, a GST rate the item never had, an
//   unknown item, not fully paid, a return of a bill that is not this
//   till's or more than was sold.
// - KEPT AND FLAGGED for a manager (the customer already paid): a price or
//   rate that changed meanwhile, an archived item, a discount above the
//   person's limit, stock going below zero, an IMEI no longer available,
//   the person's role removed, an impossible date on the till's clock, a
//   gap in the till's numbers, a return after the window, a refund the
//   server works out differently.
// The bill keeps the till's prices and rates (what the customer paid); the
// server works the totals out again with the same maths (src/lib/bill-maths)
// and refuses the bill if they differ from the till's.

const QTY = /^\d{1,11}(\.\d{1,3})?$/;
const SERIAL = /^[A-Za-z0-9-]{4,40}$/;
const MAX_PAISE = 100_000_000_000;
const paise = z.int().min(0).max(MAX_PAISE);

const opBase = {
  // The till's id for this operation (blueprint 8.1): a repeat returns the
  // first result.
  opId: z.uuid(),
  // Who sold (or took back) on the till. Must be a member of this business.
  madeBy: z.uuid(),
  // The till's clock (information only).
  madeAt: z.iso.datetime({ offset: true }),
  number: z.string().max(16),
};

export const offlineSaleOp = z.strictObject({
  kind: z.literal("sale"),
  ...opBase,
  invoiceId: z.uuid(),
  invoiceDate: z.iso.date(),
  pricesIncludeTax: z.boolean(),
  chargesGst: z.boolean(),
  lines: z
    .array(
      z.strictObject({
        lineId: z.uuid(),
        variantId: z.uuid(),
        quantity: z.string().regex(QTY),
        unitPricePaise: paise,
        taxRate: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/),
        taxLabel: z.string().trim().min(1).max(60),
        discountPaise: paise,
        serial: z.string().regex(SERIAL).nullable(),
      }),
    )
    .min(1)
    .max(200),
  billDiscountPaise: paise,
  // No credit offline (business rules 17): fully paid.
  payments: z
    .array(z.strictObject({ method: z.enum(["cash", "card", "upi"]), amountPaise: z.int().min(1).max(MAX_PAISE), reference: z.string().trim().max(100).nullable() }))
    .min(1)
    .max(5),
  payablePaise: paise,
});

export const offlineReturnOp = z.strictObject({
  kind: z.literal("return"),
  ...opBase,
  creditNoteId: z.uuid(),
  creditNoteDate: z.iso.date(),
  invoiceId: z.uuid(),
  refundMethod: z.enum(["cash", "card", "upi"]),
  reason: z.string().trim().min(3).max(500),
  lines: z
    .array(z.strictObject({ invoiceItemId: z.uuid(), quantity: z.string().regex(QTY), resellable: z.boolean() }))
    .min(1)
    .max(200),
  refundPaise: paise,
});

export const offlineOperation = z.discriminatedUnion("kind", [offlineSaleOp, offlineReturnOp]);
export type OfflineOperation = z.output<typeof offlineOperation>;
export type OfflineSaleOp = z.output<typeof offlineSaleOp>;
export type OfflineReturnOp = z.output<typeof offlineReturnOp>;

// The person who made the operation, as the server sees them NOW.
export interface Seller {
  ctx: TenantContext;
  canSell: boolean;
  unlimitedDiscount: boolean;
  mayPassWindow: boolean;
}

export interface FoundFlag {
  code: string;
  detail: Record<string, string | number | null>;
}

const dayIn = (at: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

// The till's day is kept when it can be true: not before the till was
// registered and not after today. A clock that was wrong gives today and a
// flag.
function plausibleDay(tillDay: string, till: ActiveTill, timeZone: string, flags: FoundFlag[]): string {
  const today = todayIn(timeZone);
  if (tillDay >= dayIn(till.registeredAt, timeZone) && tillDay <= today) return tillDay;
  flags.push({ code: "date_corrected", detail: { tillDay, usedDay: today } });
  return today;
}

// The till's own number for this document: right series, right year, not
// used before. A skipped number is kept and flagged (number_gap).
async function claimNumber(
  tx: TenantTx,
  ctx: TenantContext,
  kind: "invoice" | "credit_note",
  number: string,
  expected: { prefix: string; day: string; startMonth: number },
  flags: FoundFlag[],
): Promise<{ prefix: string; financialYear: string; number: number }> {
  const parsed = parseDocumentNumber(number);
  if (parsed?.prefix !== expected.prefix || parsed.financialYear !== financialYearOfDay(expected.day, expected.startMonth)) {
    throw new SalesError("OFFLINE_BAD_NUMBER");
  }
  const previous = await repo.claimTillNumber(tx, ctx, { kind, prefix: parsed.prefix, financialYear: parsed.financialYear }, parsed.number);
  if (parsed.number <= previous) throw new SalesError("OFFLINE_NUMBER_USED");
  if (parsed.number > previous + 1) flags.push({ code: "number_gap", detail: { expected: previous + 1, got: parsed.number } });
  return parsed;
}

export async function applyOfflineSale(
  tx: TenantTx,
  ctx: TenantContext,
  till: ActiveTill,
  seller: Seller,
  op: OfflineSaleOp,
): Promise<{ id: string; number: string; flags: FoundFlag[] }> {
  const flags: FoundFlag[] = [];
  const business = await repo.saleSettings(tx);
  if (business === undefined || business.gstRegistration === null || business.stateCode === null) throw new SalesError("SETTINGS_INCOMPLETE");
  // A bill of supply and a tax invoice are different documents: a till that
  // still thought otherwise cannot be recorded as it printed.
  if (op.chargesGst !== (business.gstRegistration === "registered")) throw new SalesError("OFFLINE_GST_REGISTRATION_CHANGED");
  if (op.pricesIncludeTax !== business.pricesIncludeTax) flags.push({ code: "settings_changed", detail: { tillPricesIncludeTax: op.pricesIncludeTax ? "yes" : "no" } });

  // The lines: each item known, IMEI items one per line with a number.
  if (new Set(op.lines.map((l) => l.lineId)).size !== op.lines.length) throw new SalesError("BAD_BILL", "Each line once.");
  const serials = op.lines.flatMap((l) => (l.serial === null ? [] : [l.serial.toUpperCase()]));
  if (new Set(serials).size !== serials.length) throw new SalesError("ONE_IMEI_PER_LINE");
  const items = await variantsForSale(tx, op.lines.map((l) => l.variantId));
  const itemOf = (variantId: string) => {
    const item = items.get(variantId);
    if (item === undefined) throw new SalesError("ITEM_NOT_FOUND");
    return item;
  };
  for (const l of op.lines) {
    const item = itemOf(l.variantId);
    if (item.trackSerial !== (l.serial !== null) || (item.trackSerial && quantityToMilli(l.quantity) !== 1000n)) throw new SalesError("ONE_IMEI_PER_LINE");
  }

  // Rates: the till's, if the item's tax category has (or had) that rate.
  const rates = op.chargesGst ? await taxRatesFor(tx, [...new Set(op.lines.map((l) => itemOf(l.variantId).taxCategory))]) : new Map<string, TaxRateRow[]>();
  for (const l of op.lines) {
    const known = op.chargesGst ? (rates.get(itemOf(l.variantId).taxCategory) ?? []).map((r) => rateToE4(r.rate)) : [0n];
    if (!known.includes(rateToE4(l.taxRate))) throw new SalesError("OFFLINE_BAD_RATE", `(${itemOf(l.variantId).productName})`);
  }

  // The bill as the till worked it out, again here: it must add up.
  const lines = op.lines.map((l) => ({ quantity: l.quantity, unitPricePaise: l.unitPricePaise, discountPaise: l.discountPaise, taxRate: l.taxRate }));
  const result = bill(lines, { pricesIncludeTax: op.pricesIncludeTax, chargesGst: op.chargesGst, interState: false, billDiscountPaise: op.billDiscountPaise });
  if (result.payablePaise !== op.payablePaise) throw new SalesError("OFFLINE_TOTAL_MISMATCH");
  if (op.payments.reduce((sum, p) => sum + p.amountPaise, 0) !== result.payablePaise) throw new SalesError("OFFLINE_NOT_FULLY_PAID");

  const day = plausibleDay(op.invoiceDate, till, business.timeZone, flags);
  const number = await claimNumber(tx, ctx, "invoice", op.number, { prefix: till.prefix, day: op.invoiceDate, startMonth: business.financialYearStartMonth }, flags);

  // Late checks (kept, flagged).
  const untaxed = bill(
    lines.map((l) => ({ ...l, taxRate: "0" })),
    { pricesIncludeTax: true, chargesGst: false, interState: false, billDiscountPaise: op.billDiscountPaise },
  );
  op.lines.forEach((l, i) => {
    const item = itemOf(l.variantId);
    const name = item.variantLabel === "" ? item.productName : `${item.productName} · ${item.variantLabel}`;
    if (!item.active) flags.push({ code: "item_archived", detail: { item: name } });
    if (l.unitPricePaise !== item.sellingPricePaise) flags.push({ code: "price_changed", detail: { item: name, paidPaise: l.unitPricePaise, nowPaise: item.sellingPricePaise } });
    if (op.chargesGst) {
      const perPiece = Number((BigInt(untaxed.lines[i]?.totalPaise ?? 0) * 1000n) / quantityToMilli(l.quantity));
      let now: string | null = null;
      try {
        now = pickTaxRate(rates.get(item.taxCategory) ?? [], item.taxCategory, day, perPiece).rate;
      } catch {
        now = null;
      }
      if (now === null || rateToE4(now) !== rateToE4(l.taxRate)) flags.push({ code: "tax_changed", detail: { item: name, chargedRate: l.taxRate, nowRate: now } });
    }
  });
  if (!seller.unlimitedDiscount && !discountWithinLimit(result, business.cashierDiscountLimitBps)) flags.push({ code: "discount_over_limit", detail: { discountPaise: result.discountPaise } });
  if (!seller.canSell) flags.push({ code: "role_removed", detail: { personId: seller.ctx.userId } });

  // The bill, recorded as made by the person who sold.
  try {
    await repo.insertInvoice(tx, seller.ctx, {
      id: op.invoiceId,
      branchId: till.branchId,
      number: op.number,
      prefix: number.prefix,
      financialYear: number.financialYear,
      sequenceNumber: number.number,
      invoiceDate: day,
      sellerName: business.businessName,
      sellerAddress: sellerAddress(business),
      sellerGstin: business.gstin,
      sellerStateCode: business.stateCode,
      gstRegistration: business.gstRegistration,
      pricesIncludeTax: op.pricesIncludeTax,
      chargesGst: op.chargesGst,
      customerId: null,
      buyerName: null,
      buyerPhone: null,
      buyerAddress: null,
      buyerGstin: null,
      placeOfSupply: business.stateCode,
      interState: false,
      grossPaise: result.grossPaise,
      discountPaise: result.discountPaise,
      taxablePaise: result.taxablePaise,
      cgstPaise: result.cgstPaise,
      sgstPaise: result.sgstPaise,
      igstPaise: result.igstPaise,
      taxPaise: result.taxPaise,
      totalPaise: result.totalPaise,
      roundOffPaise: result.roundOffPaise,
      payablePaise: result.payablePaise,
      paidPaise: result.payablePaise,
      creditPaise: 0,
      deviceId: till.id,
      offlineAt: new Date(op.madeAt),
      syncedBy: ctx.userId,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new SalesError("DUPLICATE_INVOICE");
    throw error;
  }

  // IMEIs: the first till to sync wins; a number no longer in stock here
  // is flagged and the unit still goes out of stock.
  const taken: ({ id: string; version: number } | null)[] = [];
  for (const l of op.lines) {
    if (l.serial === null) {
      taken.push(null);
      continue;
    }
    const serial = await takeSerialIfAvailable(tx, { variantId: l.variantId, branchId: till.branchId, serial: l.serial });
    if (serial === null) flags.push({ code: "imei_unavailable", detail: { item: itemOf(l.variantId).productName, imei: l.serial } });
    taken.push(serial);
  }
  const movements: MovementInput[] = op.lines.map((l, i) => ({
    branchId: till.branchId,
    variantId: l.variantId,
    type: "SALE_OUT",
    quantity: `-${l.quantity}`,
    sourceType: "invoice",
    sourceId: op.invoiceId,
    sourceLineId: l.lineId,
    ...(taken[i] ? { serialNumberId: taken[i].id } : {}),
  }));
  await postMovements(tx, seller.ctx, movements, { offlineSale: true });
  const short = await belowZero(tx, till.branchId, op.lines.map((l) => l.variantId));
  for (const variantId of short) flags.push({ code: "stock_short", detail: { item: itemOf(variantId).productName } });
  const costs = await unitCostsOf(tx, "invoice", op.invoiceId);

  await repo.insertItems(
    tx,
    seller.ctx,
    op.lines.map((l, i) => {
      const item = itemOf(l.variantId);
      const amounts = result.lines[i];
      if (amounts === undefined) throw new Error("bill line missing");
      return {
        id: l.lineId,
        invoiceId: op.invoiceId,
        lineNumber: i + 1,
        variantId: l.variantId,
        productName: item.productName,
        variantLabel: item.variantLabel,
        sku: item.sku,
        hsnCode: item.hsnCode,
        unitCode: item.unitCode,
        serialNumberId: taken[i]?.id ?? null,
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
        taxCategory: item.taxCategory,
        taxLabel: l.taxLabel,
        taxRate: l.taxRate,
        grossPaise: amounts.grossPaise,
        lineDiscountPaise: amounts.lineDiscountPaise,
        billDiscountPaise: amounts.billDiscountPaise,
        taxablePaise: amounts.taxablePaise,
        cgstPaise: amounts.cgstPaise,
        sgstPaise: amounts.sgstPaise,
        igstPaise: amounts.igstPaise,
        totalPaise: amounts.totalPaise,
        unitCostPaise: costs.get(l.lineId) ?? "0",
      };
    }),
  );
  await repo.insertPayments(
    tx,
    seller.ctx,
    op.payments.map((p) => ({ invoiceId: op.invoiceId, method: p.method, amountPaise: p.amountPaise, reference: p.reference === "" ? null : p.reference, kind: "sale" })),
  );
  await markSerialsSold(
    tx,
    op.lines.flatMap((l, i) => {
      const serial = taken[i];
      const months = itemOf(l.variantId).warrantyMonths;
      return !serial ? [] : [{ serial, invoiceItemId: l.lineId, warrantyEndsOn: months === null || months === 0 ? null : addMonths(day, months) }];
    }),
  );
  await repo.addAuditEntry(tx, seller.ctx, {
    action: "sales.invoice_created",
    entityType: "invoice",
    entityId: op.invoiceId,
    before: null,
    after: { number: op.number, payablePaise: result.payablePaise, discountPaise: result.discountPaise, paidPaise: result.payablePaise, creditPaise: 0, lines: op.lines.length, offline: true, till: till.name },
  });
  return { id: op.invoiceId, number: op.number, flags };
}

export async function applyOfflineReturn(
  tx: TenantTx,
  ctx: TenantContext,
  till: ActiveTill,
  seller: Seller,
  op: OfflineReturnOp,
): Promise<{ id: string; number: string; flags: FoundFlag[] }> {
  const flags: FoundFlag[] = [];
  const business = await repo.saleSettings(tx);
  if (business === undefined) throw new SalesError("SETTINGS_INCOMPLETE");
  // Business rules 17: only this till's own bills. Its sale is always sent
  // first; if it has not arrived (yet), the till tries again later.
  const invoice = await repo.lockInvoice(tx, op.invoiceId);
  if (invoice === undefined) throw new SalesError("OFFLINE_SALE_NOT_SYNCED");
  if (invoice.deviceId !== till.id) throw new SalesError("OFFLINE_NOT_THIS_TILL");

  const day = plausibleDay(op.creditNoteDate, till, business.timeZone, flags);
  const number = await claimNumber(tx, ctx, "credit_note", op.number, { prefix: tillCreditNotePrefix(till.prefix), day: op.creditNoteDate, startMonth: business.financialYearStartMonth }, flags);
  const plan = await planReturn(tx, seller.ctx, { invoiceId: op.invoiceId, lines: op.lines }, { mayPassWindow: true, today: day, creditNote: number });
  if (plan.outsideWindow && !seller.mayPassWindow) flags.push({ code: "return_after_window", detail: { billDay: invoice.invoiceDate, returnDay: day } });
  if (plan.refundPaise !== op.refundPaise) flags.push({ code: "refund_differs", detail: { paidPaise: op.refundPaise, nowPaise: plan.refundPaise } });
  if (!seller.canSell) flags.push({ code: "role_removed", detail: { personId: seller.ctx.userId } });
  await writeReturn(tx, seller.ctx, plan, {
    creditNoteId: op.creditNoteId,
    branchId: till.branchId,
    reason: op.reason,
    refundMethod: op.refundMethod,
    offline: { deviceId: till.id, offlineAt: new Date(op.madeAt), syncedBy: ctx.userId },
  });
  return { id: op.creditNoteId, number: plan.creditNote.formatted, flags };
}

// --- The till's offline copy (decision 0006; blueprint 8.5) -------------------

export interface TillSnapshotDto {
  serverTime: string;
  till: { id: string; name: string; prefix: string; creditNotePrefix: string; branchId: string; branchName: string };
  user: { id: string; mayGiveAnyDiscount: boolean; mayReturnAfterWindow: boolean };
  settings: {
    ready: boolean;
    businessName: string;
    sellerAddress: string | null;
    gstin: string | null;
    stateCode: string | null;
    pricesIncludeTax: boolean;
    chargesGst: boolean;
    discountLimitBps: number;
    timeZone: string;
    financialYearStartMonth: number;
    returnWindowDays: number;
    offlineWindowHours: number;
  };
  // Never cost prices.
  items: { variantId: string; name: string; sku: string; codes: string[]; hsnCode: string | null; unitCode: string; allowsFraction: boolean; trackSerial: boolean; pricePaise: number; taxCategory: string }[];
  taxRates: Record<string, TaxRateRow[]>;
  serials: { serial: string; variantId: string }[];
  lastNumbers: { series: "invoice" | "credit_note"; financialYear: string; last: number }[];
  recentBills: {
    invoiceId: string;
    number: string;
    invoiceDate: string;
    payablePaise: number;
    lines: { invoiceItemId: string; lineNumber: number; name: string; sku: string; serial: string | null; unitCode: string; sold: string; returned: string; taxablePaise: number; cgstPaise: number; igstPaise: number; totalPaise: number }[];
  }[];
}

const RECENT_BILLS = 300;

export async function buildTillSnapshot(
  tx: TenantTx,
  ctx: TenantContext,
  till: ActiveTill,
  user: { mayGiveAnyDiscount: boolean; mayReturnAfterWindow: boolean },
): Promise<TillSnapshotDto> {
  const business = await repo.saleSettings(tx);
  const windowHours = await repo.offlineWindowHours(tx);
  const timeZone = business?.timeZone ?? "Asia/Kolkata";
  const catalog = (await catalogForTill(tx)).filter((i) => i.active);
  const rates = await taxRatesFor(tx, [...new Set(catalog.map((i) => i.taxCategory))]);
  const today = todayIn(timeZone);
  const returnWindowDays = business?.returnWindowDays ?? 7;
  // Bills still inside the return window (business rules 16 and 17).
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - returnWindowDays * 86_400_000).toISOString().slice(0, 10);
  const bills = await repo.recentBillsOf(tx, till.id, from, RECENT_BILLS);
  const items = await repo.itemsOfMany(tx, bills.map((b) => b.id));
  const returned = await repo.returnedQuantitiesOfMany(tx, bills.map((b) => b.id));
  const serialTexts = await repo.serialTexts(tx, items.flatMap((i) => (i.serialNumberId === null ? [] : [i.serialNumberId])));
  const cnPrefix = tillCreditNotePrefix(till.prefix);
  return {
    serverTime: new Date().toISOString(),
    till: { id: till.id, name: till.name, prefix: till.prefix, creditNotePrefix: cnPrefix, branchId: till.branchId, branchName: till.branchName },
    user: { id: ctx.userId, ...user },
    settings: {
      ready: business !== undefined && business.gstRegistration !== null && business.stateCode !== null,
      businessName: business?.businessName ?? "",
      sellerAddress: business === undefined ? null : sellerAddress(business),
      gstin: business?.gstin ?? null,
      stateCode: business?.stateCode ?? null,
      pricesIncludeTax: business?.pricesIncludeTax ?? true,
      chargesGst: business?.gstRegistration === "registered",
      discountLimitBps: business?.cashierDiscountLimitBps ?? 0,
      timeZone,
      financialYearStartMonth: business?.financialYearStartMonth ?? 4,
      returnWindowDays,
      offlineWindowHours: windowHours,
    },
    items: catalog.map((i) => ({
      variantId: i.variantId,
      name: i.variantLabel === "" ? i.productName : `${i.productName} · ${i.variantLabel}`,
      sku: i.sku,
      codes: i.codes,
      hsnCode: i.hsnCode,
      unitCode: i.unitCode,
      allowsFraction: i.allowsFraction,
      trackSerial: i.trackSerial,
      pricePaise: i.sellingPricePaise,
      taxCategory: i.taxCategory,
    })),
    taxRates: Object.fromEntries(rates),
    serials: await inStockSerialsAt(tx, till.branchId),
    lastNumbers: (await repo.lastNumbersOf(tx, [till.prefix, cnPrefix])).flatMap((r) =>
      (r.series === "invoice" && r.prefix === till.prefix) || (r.series === "credit_note" && r.prefix === cnPrefix) ? [{ series: r.series, financialYear: r.financialYear, last: r.last }] : [],
    ),
    recentBills: bills.map((b) => ({
      invoiceId: b.id,
      number: b.number,
      invoiceDate: b.invoiceDate,
      payablePaise: b.payablePaise,
      lines: items
        .filter((i) => i.invoiceId === b.id)
        .map((i) => ({
          invoiceItemId: i.id,
          lineNumber: i.lineNumber,
          name: i.variantLabel === "" ? i.productName : `${i.productName} · ${i.variantLabel}`,
          sku: i.sku,
          serial: i.serialNumberId === null ? null : (serialTexts.get(i.serialNumberId) ?? null),
          unitCode: i.unitCode,
          sold: i.quantity,
          returned: milliText(quantityToMilli(returned.get(i.id) ?? "0")),
          taxablePaise: i.taxablePaise,
          cgstPaise: i.cgstPaise,
          igstPaise: i.igstPaise,
          totalPaise: i.totalPaise,
        })),
    })),
  };
}
