import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantContext, type TenantTx } from "@/db/with-tenant";
import { BillMathError, computeBill, discountWithinLimit, quantityToMilli, type BillLineInput } from "@/lib/bill-maths";
import { hasPermission, requirePermission, type Permission } from "@/modules/auth";
import { variantsForSale } from "@/modules/catalog";
import { markSerialsSold, postMovements, reverseStockOf, takeSerialsForSale, unitCostsOf, type MovementInput } from "@/modules/inventory";
import { assertWithinCredit, bookCustomerEntry, lockCustomerForSale } from "@/modules/parties";
import { claimIdempotencyKey } from "@/modules/sync";
import { pickTaxRate, taxRatesFor, type TaxRateRow } from "@/modules/tax";
import { financialYearLabel, financialYearStart } from "./numbering";
import * as repo from "./repo";
import { takeNextNumber } from "./sequence";

// The sale (blueprint 7.5; business rules 3-8 and 15) as ONE transaction:
// idempotency key, settings, items, prices and tax rates from the database
// (never from the browser), discount limit, customer and credit, the bill
// number, the bill with its lines and payments, stock out, IMEI numbers
// sold, the customer's account, and the audit entry. Any failure undoes
// everything, including the bill number.

const VIEW: readonly Permission[] = ["sales.create", "reports.view", "invoices.void"];
const QTY_POSITIVE = /^\d{1,11}(\.\d{1,3})?$/;
const SERIAL = /^[A-Za-z0-9-]{4,40}$/;
const MAX_PAISE = 100_000_000_000;

export type SalesErrorCode =
  | "SETTINGS_INCOMPLETE"
  | "ITEM_NOT_FOUND"
  | "ITEM_ARCHIVED"
  | "ONE_IMEI_PER_LINE"
  | "BAD_BILL"
  | "PRICES_CHANGED"
  | "DISCOUNT_OVER_LIMIT"
  | "OVERPAID"
  | "CREDIT_NEEDS_CUSTOMER"
  | "DUPLICATE_INVOICE"
  | "NOT_FOUND"
  | "ALREADY_VOIDED"
  | "VOID_ONLY_SAME_DAY";

const MESSAGES: Record<SalesErrorCode, string> = {
  SETTINGS_INCOMPLETE: "Set the business's state and GST registration in Business settings before billing.",
  ITEM_NOT_FOUND: "An item on this bill was not found.",
  ITEM_ARCHIVED: "An item on this bill is archived and cannot be sold.",
  ONE_IMEI_PER_LINE: "IMEI items are sold one per line, each with its IMEI/serial number.",
  BAD_BILL: "Please check the bill.",
  PRICES_CHANGED: "Prices or rates changed while this bill was open. Check the new total and save again.",
  DISCOUNT_OVER_LIMIT: "This discount is above your limit. Ask a manager.",
  OVERPAID: "The payments are more than the bill. Enter the amount kept (give the change back).",
  CREDIT_NEEDS_CUSTOMER: "Choose a customer to put the unpaid amount on their account.",
  DUPLICATE_INVOICE: "This bill was already saved.",
  NOT_FOUND: "This bill was not found.",
  ALREADY_VOIDED: "This bill is already voided.",
  VOID_ONLY_SAME_DAY: "A bill can be voided only on the day it was made. Use a return instead.",
};

export class SalesError extends Error {
  constructor(
    public readonly code: SalesErrorCode,
    detail?: string,
  ) {
    super(detail === undefined ? MESSAGES[code] : `${MESSAGES[code]} ${detail}`);
    this.name = "SalesError";
  }
}

export const createSaleInput = z.strictObject({
  // Retries and double clicks send the same key (blueprint 8.1).
  idempotencyKey: z.uuid(),
  // The bill's id, made on the device.
  invoiceId: z.uuid(),
  branchId: z.uuid(),
  customerId: z.uuid().nullable().default(null),
  lines: z
    .array(
      z.strictObject({
        variantId: z.uuid(),
        quantity: z.string().trim().regex(QTY_POSITIVE, { error: "Enter a quantity (at most 3 decimals)." }),
        discountPaise: z.int().min(0).max(MAX_PAISE).default(0),
        serial: z.string().trim().regex(SERIAL, { error: "IMEI/serial: 4 to 40 letters, digits or -" }).nullable().default(null),
      }),
    )
    .min(1, { error: "Add at least one item." })
    .max(200),
  billDiscountPaise: z.int().min(0).max(MAX_PAISE).default(0),
  payments: z
    .array(
      z.strictObject({
        method: z.enum(["cash", "card", "upi"]),
        amountPaise: z.int().min(1).max(MAX_PAISE),
        reference: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(100).nullable()).default(null),
      }),
    )
    .max(5)
    .default([]),
  // What the till showed. If the server's total differs (a price or rate
  // changed meanwhile), the sale is refused rather than charging a surprise.
  expectedPayablePaise: z.int().min(0).max(MAX_PAISE).nullable().default(null),
});

export const voidInvoiceInput = z.strictObject({
  idempotencyKey: z.uuid(),
  invoiceId: z.uuid(),
  reason: z.string().trim().min(3, { error: "Say why this bill is voided." }).max(500),
});

export interface InvoiceDto {
  id: string;
  number: string;
  invoiceDate: string;
  status: "posted" | "voided";
  branchId: string;
  seller: { name: string; address: string | null; gstin: string | null; stateCode: string; gstRegistration: string };
  buyer: { customerId: string | null; name: string | null; phone: string | null; address: string | null; gstin: string | null };
  placeOfSupply: string;
  interState: boolean;
  pricesIncludeTax: boolean;
  chargesGst: boolean;
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
  roundOffPaise: number;
  payablePaise: number;
  paidPaise: number;
  creditPaise: number;
  voidReason: string | null;
  createdAt: string;
  items: {
    lineNumber: number;
    variantId: string;
    productName: string;
    variantLabel: string;
    sku: string;
    hsnCode: string | null;
    unitCode: string;
    serial: string | null;
    quantity: string;
    unitPricePaise: number;
    taxLabel: string;
    taxRate: string;
    grossPaise: number;
    discountPaise: number;
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    totalPaise: number;
    // Only for "View cost price and profit".
    unitCostPaise?: string;
  }[];
  payments: { method: string; amountPaise: number; reference: string | null; kind: "sale" | "void" }[];
}

const todayIn = (timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// YYYY-MM-DD plus whole months, keeping the day where it exists (31 Jan +
// 1 month = 28/29 Feb).
function addMonths(day: string, months: number): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

// "12 Market Road, Near Bus Stand, Chennai 600001 · Phone +91 98400 00000"
function sellerAddress(b: { addressLine1: string | null; addressLine2: string | null; city: string | null; pincode: string | null; phone: string | null }): string | null {
  const place = [b.city, b.pincode].filter((p): p is string => p !== null && p !== "").join(" ");
  const address = [b.addressLine1, b.addressLine2, place].filter((p): p is string => p !== null && p !== "").join(", ");
  const text = [address, b.phone === null || b.phone === "" ? "" : `Phone ${b.phone}`].filter((p) => p !== "").join(" · ");
  return text === "" ? null : text;
}

const isUniqueViolation = (error: unknown): boolean => {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return cause instanceof Error && "code" in cause && cause.code === "23505";
};

function bill(lines: BillLineInput[], options: { pricesIncludeTax: boolean; chargesGst: boolean; interState: boolean; billDiscountPaise: number }) {
  try {
    return computeBill({ lines, ...options, roundOff: true });
  } catch (error) {
    if (error instanceof BillMathError) throw new SalesError("BAD_BILL", error.message);
    throw error;
  }
}

export async function createSale(ctx: TenantContext, rawInput: unknown): Promise<{ invoiceId: string }> {
  await requirePermission(ctx, "sales.create");
  const input = createSaleInput.parse(rawInput);
  const unlimitedDiscount = await hasPermission(ctx, "discounts.above_limit");
  return withTenant(ctx, async (tx) => {
    // 1. A retry or double click returns the bill already saved.
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "sales.create", { invoiceId: input.invoiceId });
    if (!claim.claimed) return claim.result;

    // 2-3. Settings, items, prices and rates from the database.
    const business = await repo.saleSettings(tx);
    if (business === undefined || business.gstRegistration === null || business.stateCode === null) throw new SalesError("SETTINGS_INCOMPLETE");
    const chargesGst = business.gstRegistration === "registered";
    const invoiceDate = todayIn(business.timeZone);
    const items = await variantsForSale(tx, input.lines.map((l) => l.variantId));
    for (const line of input.lines) {
      const item = items.get(line.variantId);
      if (item === undefined) throw new SalesError("ITEM_NOT_FOUND");
      if (!item.active) throw new SalesError("ITEM_ARCHIVED", `(${item.productName})`);
      if (item.trackSerial !== (line.serial !== null) || (item.trackSerial && !/^1(\.0+)?$/.test(line.quantity))) throw new SalesError("ONE_IMEI_PER_LINE");
    }
    const itemOf = (variantId: string) => {
      const item = items.get(variantId);
      if (item === undefined) throw new SalesError("ITEM_NOT_FOUND");
      return item;
    };

    // Customer, place of supply (open question 18: walk-in and unregistered
    // buyers are in the shop's state; a registered buyer's GSTIN decides).
    const customer = input.customerId === null ? null : await lockCustomerForSale(tx, input.customerId);
    const placeOfSupply = customer !== null && customer.gstin !== null && customer.stateCode !== null ? customer.stateCode : business.stateCode;
    const interState = placeOfSupply !== business.stateCode;

    // Rates depend on the price per piece after discounts (open question 2),
    // so the bill is worked out once without tax to find each line's price.
    const baseLines = input.lines.map((l) => ({ quantity: l.quantity, unitPricePaise: itemOf(l.variantId).sellingPricePaise, discountPaise: l.discountPaise, taxRate: "0" }));
    const untaxed = bill(baseLines, { pricesIncludeTax: true, chargesGst: false, interState: false, billDiscountPaise: input.billDiscountPaise });
    const rates = chargesGst ? await taxRatesFor(tx, [...new Set(input.lines.map((l) => itemOf(l.variantId).taxCategory))]) : new Map<string, TaxRateRow[]>();
    const chosen = input.lines.map((l, i) => {
      // A bill of supply (composition / unregistered) charges no GST.
      if (!chargesGst) return { label: "No GST (bill of supply)", rate: "0" };
      const amount = untaxed.lines[i]?.totalPaise ?? 0;
      const perPiece = Number((BigInt(amount) * 1000n) / quantityToMilli(l.quantity));
      const category = itemOf(l.variantId).taxCategory;
      return pickTaxRate(rates.get(category) ?? [], category, invoiceDate, perPiece);
    });
    const result = bill(
      baseLines.map((l, i) => ({ ...l, taxRate: chosen[i]?.rate ?? "0" })),
      { pricesIncludeTax: business.pricesIncludeTax, chargesGst, interState, billDiscountPaise: input.billDiscountPaise },
    );

    // 4. Discount limit (rule 8).
    if (!unlimitedDiscount && !discountWithinLimit(result, business.cashierDiscountLimitBps)) throw new SalesError("DISCOUNT_OVER_LIMIT");
    if (input.expectedPayablePaise !== null && input.expectedPayablePaise !== result.payablePaise) throw new SalesError("PRICES_CHANGED");

    // 6. Payments and credit.
    const paidPaise = input.payments.reduce((sum, p) => sum + p.amountPaise, 0);
    if (paidPaise > result.payablePaise) throw new SalesError("OVERPAID");
    const creditPaise = result.payablePaise - paidPaise;
    if (creditPaise > 0) {
      if (customer === null) throw new SalesError("CREDIT_NEEDS_CUSTOMER");
      assertWithinCredit(customer, creditPaise);
    }

    // 7. The bill number (row lock; given back if anything below fails).
    const fyStart = financialYearStart(new Date(), business.timeZone, business.financialYearStartMonth);
    const financialYear = financialYearLabel(fyStart, business.financialYearStartMonth);
    const number = await takeNextNumber(tx, ctx, { kind: "invoice", prefix: business.invoicePrefix, financialYear });

    // 8. The bill.
    try {
      await repo.insertInvoice(tx, ctx, {
        id: input.invoiceId,
        branchId: input.branchId,
        number: number.formatted,
        prefix: business.invoicePrefix,
        financialYear,
        sequenceNumber: number.number,
        invoiceDate,
        sellerName: business.businessName,
        sellerAddress: sellerAddress(business),
        sellerGstin: business.gstin,
        sellerStateCode: business.stateCode,
        gstRegistration: business.gstRegistration,
        pricesIncludeTax: business.pricesIncludeTax,
        chargesGst,
        customerId: customer?.id ?? null,
        buyerName: customer?.name ?? null,
        buyerPhone: customer?.phone ?? null,
        buyerAddress: customer?.address ?? null,
        buyerGstin: customer?.gstin ?? null,
        placeOfSupply,
        interState,
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
        paidPaise,
        creditPaise,
      });
    } catch (error) {
      // The same bill id sent again under a different key.
      if (isUniqueViolation(error)) throw new SalesError("DUPLICATE_INVOICE");
      throw error;
    }

    // 5 and 9. IMEIs checked and locked, stock out (locked, never below zero).
    const lineIds = input.lines.map(() => randomUUID());
    const serials: ({ id: string; version: number } | null)[] = [];
    for (const l of input.lines) {
      serials.push(l.serial === null ? null : ((await takeSerialsForSale(tx, { variantId: l.variantId, branchId: input.branchId, serials: [l.serial] }))[0] ?? null));
    }
    const movements: MovementInput[] = input.lines.map((l, i) => ({
      branchId: input.branchId,
      variantId: l.variantId,
      type: "SALE_OUT",
      quantity: `-${l.quantity}`,
      sourceType: "invoice",
      sourceId: input.invoiceId,
      sourceLineId: lineIds[i] ?? "",
      ...(serials[i] ? { serialNumberId: serials[i].id } : {}),
    }));
    await postMovements(tx, ctx, movements);
    const costs = await unitCostsOf(tx, "invoice", input.invoiceId);

    await repo.insertItems(
      tx,
      ctx,
      input.lines.map((l, i) => {
        const item = itemOf(l.variantId);
        const amounts = result.lines[i];
        const rate = chosen[i];
        if (amounts === undefined || rate === undefined) throw new Error("bill line missing");
        return {
          id: lineIds[i],
          invoiceId: input.invoiceId,
          lineNumber: i + 1,
          variantId: l.variantId,
          productName: item.productName,
          variantLabel: item.variantLabel,
          sku: item.sku,
          hsnCode: item.hsnCode,
          unitCode: item.unitCode,
          serialNumberId: serials[i]?.id ?? null,
          quantity: l.quantity,
          unitPricePaise: item.sellingPricePaise,
          taxCategory: item.taxCategory,
          taxLabel: rate.label,
          taxRate: rate.rate,
          grossPaise: amounts.grossPaise,
          lineDiscountPaise: amounts.lineDiscountPaise,
          billDiscountPaise: amounts.billDiscountPaise,
          taxablePaise: amounts.taxablePaise,
          cgstPaise: amounts.cgstPaise,
          sgstPaise: amounts.sgstPaise,
          igstPaise: amounts.igstPaise,
          totalPaise: amounts.totalPaise,
          unitCostPaise: costs.get(lineIds[i] ?? "") ?? "0",
        };
      }),
    );
    await repo.insertPayments(
      tx,
      ctx,
      input.payments.map((p) => ({ invoiceId: input.invoiceId, method: p.method, amountPaise: p.amountPaise, reference: p.reference, kind: "sale" })),
    );
    await markSerialsSold(
      tx,
      input.lines.flatMap((l, i) => {
        const serial = serials[i];
        const months = itemOf(l.variantId).warrantyMonths;
        return !serial ? [] : [{ serial, invoiceItemId: lineIds[i] ?? "", warrantyEndsOn: months === null || months === 0 ? null : addMonths(invoiceDate, months) }];
      }),
    );

    // 10. The customer's account.
    if (customer !== null && creditPaise > 0) {
      await bookCustomerEntry(tx, ctx, { customerId: customer.id, entryType: "invoice", amountPaise: creditPaise, sourceType: "invoice", sourceId: input.invoiceId, note: number.formatted });
    }

    // 11. Audit.
    await repo.addAuditEntry(tx, ctx, {
      action: "sales.invoice_created",
      entityType: "invoice",
      entityId: input.invoiceId,
      before: null,
      after: { number: number.formatted, payablePaise: result.payablePaise, discountPaise: result.discountPaise, paidPaise, creditPaise, lines: input.lines.length },
    });
    return { invoiceId: input.invoiceId };
  });
}

// Void (business rules 6 and 15): Manager or above, with a reason, only on
// the day of the bill. New rows reverse the stock, the money received and
// the customer's account; the bill's own rows never change.
export async function voidInvoice(ctx: TenantContext, rawInput: unknown): Promise<{ invoiceId: string }> {
  await requirePermission(ctx, "invoices.void");
  const input = voidInvoiceInput.parse(rawInput);
  return withTenant(ctx, async (tx) => {
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "sales.void", { invoiceId: input.invoiceId });
    if (!claim.claimed) return claim.result;
    const invoice = await repo.lockInvoice(tx, input.invoiceId);
    if (invoice === undefined) throw new SalesError("NOT_FOUND");
    if (invoice.status !== "posted") throw new SalesError("ALREADY_VOIDED");
    const business = await repo.saleSettings(tx);
    if (business === undefined || invoice.invoiceDate !== todayIn(business.timeZone)) throw new SalesError("VOID_ONLY_SAME_DAY");

    await reverseStockOf(tx, ctx, { sourceType: "invoice", sourceId: invoice.id, reversalSourceType: "invoice_void", note: input.reason });
    const received = (await repo.paymentsOf(tx, invoice.id)).filter((p) => p.kind === "sale");
    await repo.insertPayments(
      tx,
      ctx,
      received.map((p) => ({ invoiceId: invoice.id, method: p.method, amountPaise: -p.amountPaise, reference: p.reference, kind: "void" })),
    );
    if (invoice.customerId !== null && invoice.creditPaise > 0) {
      await bookCustomerEntry(tx, ctx, { customerId: invoice.customerId, entryType: "void_reversal", amountPaise: -invoice.creditPaise, sourceType: "invoice", sourceId: invoice.id, note: input.reason });
    }
    await repo.markVoided(tx, ctx, invoice.id, input.reason);
    await repo.addAuditEntry(tx, ctx, {
      action: "sales.invoice_voided",
      entityType: "invoice",
      entityId: invoice.id,
      before: { status: "posted", number: invoice.number },
      after: { status: "voided", reason: input.reason, refundedPaise: received.reduce((s, p) => s + p.amountPaise, 0) },
    });
    return { invoiceId: invoice.id };
  });
}

async function readInvoice(tx: TenantTx, invoiceId: string, showCost: boolean): Promise<InvoiceDto> {
  const row = await repo.findInvoice(tx, invoiceId);
  if (row === undefined) throw new SalesError("NOT_FOUND");
  const items = await repo.itemsOf(tx, invoiceId);
  const serialIds = items.map((i) => i.serialNumberId).filter((s): s is string => s !== null);
  const serialNames = await repo.serialTexts(tx, serialIds);
  const payments = await repo.paymentsOf(tx, invoiceId);
  return {
    id: row.id,
    number: row.number,
    invoiceDate: row.invoiceDate,
    status: row.status === "voided" ? "voided" : "posted",
    branchId: row.branchId,
    seller: { name: row.sellerName, address: row.sellerAddress, gstin: row.sellerGstin, stateCode: row.sellerStateCode, gstRegistration: row.gstRegistration },
    buyer: { customerId: row.customerId, name: row.buyerName, phone: row.buyerPhone, address: row.buyerAddress, gstin: row.buyerGstin },
    placeOfSupply: row.placeOfSupply,
    interState: row.interState,
    pricesIncludeTax: row.pricesIncludeTax,
    chargesGst: row.chargesGst,
    grossPaise: row.grossPaise,
    discountPaise: row.discountPaise,
    taxablePaise: row.taxablePaise,
    cgstPaise: row.cgstPaise,
    sgstPaise: row.sgstPaise,
    igstPaise: row.igstPaise,
    taxPaise: row.taxPaise,
    totalPaise: row.totalPaise,
    roundOffPaise: row.roundOffPaise,
    payablePaise: row.payablePaise,
    paidPaise: row.paidPaise,
    creditPaise: row.creditPaise,
    voidReason: row.voidReason,
    createdAt: row.createdAt.toISOString(),
    items: items.map((i) => ({
      lineNumber: i.lineNumber,
      variantId: i.variantId,
      productName: i.productName,
      variantLabel: i.variantLabel,
      sku: i.sku,
      hsnCode: i.hsnCode,
      unitCode: i.unitCode,
      serial: i.serialNumberId === null ? null : (serialNames.get(i.serialNumberId) ?? null),
      quantity: i.quantity,
      unitPricePaise: i.unitPricePaise,
      taxLabel: i.taxLabel,
      taxRate: i.taxRate,
      grossPaise: i.grossPaise,
      discountPaise: i.lineDiscountPaise + i.billDiscountPaise,
      taxablePaise: i.taxablePaise,
      cgstPaise: i.cgstPaise,
      sgstPaise: i.sgstPaise,
      igstPaise: i.igstPaise,
      totalPaise: i.totalPaise,
      ...(showCost ? { unitCostPaise: i.unitCostPaise } : {}),
    })),
    payments: payments.map((p) => ({ method: p.method, amountPaise: p.amountPaise, reference: p.reference, kind: p.kind === "void" ? "void" : "sale" })),
  };
}

export async function getInvoice(ctx: TenantContext, rawInput: unknown): Promise<InvoiceDto> {
  await requirePermission(ctx, VIEW);
  const { invoiceId } = z.strictObject({ invoiceId: z.uuid() }).parse(rawInput);
  const showCost = await hasPermission(ctx, "costs.view");
  return withTenant(ctx, (tx) => readInvoice(tx, invoiceId, showCost));
}

export interface InvoiceListItemDto {
  id: string;
  number: string;
  invoiceDate: string;
  status: "posted" | "voided";
  buyerName: string | null;
  payablePaise: number;
  paidPaise: number;
  creditPaise: number;
  createdAt: string;
}

export async function listInvoices(ctx: TenantContext, rawInput: unknown = {}): Promise<InvoiceListItemDto[]> {
  await requirePermission(ctx, VIEW);
  const input = z
    .strictObject({
      day: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .default(null),
      customerId: z.uuid().nullable().default(null),
    })
    .parse(rawInput);
  const rows = await withTenant(ctx, (tx) => repo.listInvoices(tx, input));
  return rows.map((r) => ({ ...r, status: r.status === "voided" ? "voided" : "posted", createdAt: r.createdAt.toISOString() }));
}
