import "server-only";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { BillMathError, computeBill, discountWithinLimit, quantityToMilli, type BillLineInput } from "@/lib/bill-maths";
import { variantsForSale } from "@/modules/catalog";
import { markSerialsSold, postMovements, takeSerialsForSale, unitCostsOf, type MovementInput } from "@/modules/inventory";
import { assertWithinCredit, bookCustomerEntry, lockCustomerForSale } from "@/modules/parties";
import { pickTaxRate, taxRatesFor, type TaxRateRow } from "@/modules/tax";
import { SalesError } from "./errors";
import { financialYearLabel, financialYearStart } from "./numbering";
import * as repo from "./repo";
import { takeNextNumber } from "./sequence";
import type { createSaleInput } from "./service";

// The body of a sale (blueprint 7.5 steps 2-11), inside the caller's
// transaction after the permission check and the idempotency key. Shared
// by createSale and createExchange (an exchange pays part of the new bill
// with the value of returned items).

export type SaleInput = z.output<typeof createSaleInput>;

export interface ExchangeCredit {
  // Value of the items returned in the same exchange, used first.
  creditPaise: number;
  // The credit note number, shown with the payment.
  reference: string;
}

export const todayIn = (timeZone: string): string =>
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

export async function postSale(
  tx: TenantTx,
  ctx: TenantContext,
  input: SaleInput,
  opts: { unlimitedDiscount: boolean; exchange?: ExchangeCredit },
): Promise<{ number: string; payablePaise: number; exchangeAppliedPaise: number }> {
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
  if (!opts.unlimitedDiscount && !discountWithinLimit(result, business.cashierDiscountLimitBps)) throw new SalesError("DISCOUNT_OVER_LIMIT");
  if (input.expectedPayablePaise !== null && input.expectedPayablePaise !== result.payablePaise) throw new SalesError("PRICES_CHANGED");

  // 6. Payments and credit. In an exchange, the returned items' value pays
  // first.
  const exchangeAppliedPaise = Math.min(opts.exchange?.creditPaise ?? 0, result.payablePaise);
  const paidPaise = exchangeAppliedPaise + input.payments.reduce((sum, p) => sum + p.amountPaise, 0);
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
  await repo.insertPayments(tx, ctx, [
    ...(exchangeAppliedPaise > 0 ? [{ invoiceId: input.invoiceId, method: "exchange", amountPaise: exchangeAppliedPaise, reference: opts.exchange?.reference ?? null, kind: "sale" }] : []),
    ...input.payments.map((p) => ({ invoiceId: input.invoiceId, method: p.method, amountPaise: p.amountPaise, reference: p.reference, kind: "sale" })),
  ]);
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
  return { number: number.formatted, payablePaise: result.payablePaise, exchangeAppliedPaise };
}
