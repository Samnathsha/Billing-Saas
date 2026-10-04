// An offline bill or return as the till makes it (decision 0006). Pure:
// the same maths as the server (bill-maths, tax-pick, return-maths), so
// the receipt the customer gets and the record the server keeps agree to
// the paisa. The server checks everything again (src/modules/sales/
// offline-core.ts); these shapes match its schemas.

import { computeBill, quantityToMilli, type BillResult } from "./bill-maths";
import { financialYearOfDay, formatDocumentNumber } from "./document-number";
import { returnAmounts, type ReturnAmounts } from "./return-maths";
import { pickTaxRate, type TaxRateRow } from "./tax-pick";

export interface OfflineSettings {
  pricesIncludeTax: boolean;
  chargesGst: boolean;
  timeZone: string;
  financialYearStartMonth: number;
}

export interface OfflineItem {
  variantId: string;
  name: string;
  pricePaise: number;
  taxCategory: string;
  trackSerial: boolean;
}

export interface OfflineCartLine {
  item: OfflineItem;
  quantity: string;
  discountPaise: number;
  serial: string | null;
}

export interface OfflinePayment {
  method: "cash" | "card" | "upi";
  amountPaise: number;
  reference: string | null;
}

export interface OfflineSaleOpShape {
  kind: "sale";
  opId: string;
  madeBy: string;
  madeAt: string;
  number: string;
  invoiceId: string;
  invoiceDate: string;
  pricesIncludeTax: boolean;
  chargesGst: boolean;
  lines: { lineId: string; variantId: string; quantity: string; unitPricePaise: number; taxRate: string; taxLabel: string; discountPaise: number; serial: string | null }[];
  billDiscountPaise: number;
  payments: OfflinePayment[];
  payablePaise: number;
}

export interface OfflineReturnOpShape {
  kind: "return";
  opId: string;
  madeBy: string;
  madeAt: string;
  number: string;
  creditNoteId: string;
  creditNoteDate: string;
  invoiceId: string;
  refundMethod: "cash" | "card" | "upi";
  reason: string;
  lines: { invoiceItemId: string; quantity: string; resellable: boolean }[];
  refundPaise: number;
}

// The business's calendar day at `at` (rule 1.5: days are local).
export const dayIn = (at: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

const NO_GST = { label: "No GST (bill of supply)", rate: "0" };

// The bill and each line's GST rate, chosen exactly as the server does for
// an online sale: by the price per piece after discounts (open question 2)
// on that day. Throws BillMathError or TaxRateError for a bill that cannot
// be made.
export function priceOfflineBill(
  settings: OfflineSettings,
  taxRates: Record<string, TaxRateRow[]>,
  day: string,
  lines: OfflineCartLine[],
  billDiscountPaise: number,
): { bill: BillResult; rates: { label: string; rate: string }[] } {
  const base = lines.map((l) => ({ quantity: l.quantity, unitPricePaise: l.item.pricePaise, discountPaise: l.discountPaise, taxRate: "0" }));
  const untaxed = computeBill({ lines: base, pricesIncludeTax: true, chargesGst: false, interState: false, billDiscountPaise, roundOff: true });
  const rates = lines.map((l, i) => {
    if (!settings.chargesGst) return NO_GST;
    const perPiece = Number((BigInt(untaxed.lines[i]?.totalPaise ?? 0) * 1000n) / quantityToMilli(l.quantity));
    const row = pickTaxRate(taxRates[l.item.taxCategory] ?? [], l.item.taxCategory, day, perPiece);
    return { label: row.label, rate: row.rate };
  });
  const bill = computeBill({
    lines: base.map((l, i) => ({ ...l, taxRate: rates[i]?.rate ?? "0" })),
    pricesIncludeTax: settings.pricesIncludeTax,
    chargesGst: settings.chargesGst,
    interState: false,
    billDiscountPaise,
    roundOff: true,
  });
  return { bill, rates };
}

export function makeOfflineSale(input: {
  opId: string;
  invoiceId: string;
  lineIds: string[];
  madeBy: string;
  at: Date;
  settings: OfflineSettings;
  taxRates: Record<string, TaxRateRow[]>;
  prefix: string;
  sequence: number;
  lines: OfflineCartLine[];
  billDiscountPaise: number;
  payments: OfflinePayment[];
}): { op: OfflineSaleOpShape; bill: BillResult; rates: { label: string; rate: string }[] } {
  const day = dayIn(input.at, input.settings.timeZone);
  const { bill, rates } = priceOfflineBill(input.settings, input.taxRates, day, input.lines, input.billDiscountPaise);
  const op: OfflineSaleOpShape = {
    kind: "sale",
    opId: input.opId,
    madeBy: input.madeBy,
    madeAt: input.at.toISOString(),
    number: formatDocumentNumber(input.prefix, financialYearOfDay(day, input.settings.financialYearStartMonth), input.sequence),
    invoiceId: input.invoiceId,
    invoiceDate: day,
    pricesIncludeTax: input.settings.pricesIncludeTax,
    chargesGst: input.settings.chargesGst,
    lines: input.lines.map((l, i) => ({
      lineId: input.lineIds[i] ?? "",
      variantId: l.item.variantId,
      quantity: l.quantity,
      unitPricePaise: l.item.pricePaise,
      taxRate: rates[i]?.rate ?? "0",
      taxLabel: rates[i]?.label ?? NO_GST.label,
      discountPaise: l.discountPaise,
      serial: l.serial,
    })),
    billDiscountPaise: input.billDiscountPaise,
    payments: input.payments,
    payablePaise: bill.payablePaise,
  };
  return { op, bill, rates };
}

// A line of a bill kept on the till, as the server sent it (or as the till
// made it offline).
export interface KeptBillLine {
  invoiceItemId: string;
  sold: string;
  returned: string;
  taxablePaise: number;
  cgstPaise: number;
  igstPaise: number;
}

// The refund for a return, exactly as the server works it out: each line
// at the bill's own amounts for everything returned so far minus earlier
// returns (return-maths), then rounded to the rupee like a bill.
export function refundFor(lines: { line: KeptBillLine; quantity: string }[]): { lines: ReturnAmounts[]; totalPaise: number; roundOffPaise: number; refundPaise: number } {
  const amounts = lines.map(({ line, quantity }) => returnAmounts(line, quantityToMilli(line.sold), quantityToMilli(line.returned), quantityToMilli(quantity)));
  const totalPaise = amounts.reduce((sum, a) => sum + a.totalPaise, 0);
  const roundOffPaise = Number(((2n * BigInt(totalPaise) + 100n) / 200n) * 100n) - totalPaise;
  return { lines: amounts, totalPaise, roundOffPaise, refundPaise: totalPaise + roundOffPaise };
}

export function makeOfflineReturn(input: {
  opId: string;
  creditNoteId: string;
  madeBy: string;
  at: Date;
  settings: Pick<OfflineSettings, "timeZone" | "financialYearStartMonth">;
  prefix: string;
  sequence: number;
  invoiceId: string;
  lines: { line: KeptBillLine; quantity: string; resellable: boolean }[];
  refundMethod: "cash" | "card" | "upi";
  reason: string;
}): { op: OfflineReturnOpShape; refundPaise: number } {
  const day = dayIn(input.at, input.settings.timeZone);
  const { refundPaise } = refundFor(input.lines);
  return {
    op: {
      kind: "return",
      opId: input.opId,
      madeBy: input.madeBy,
      madeAt: input.at.toISOString(),
      number: formatDocumentNumber(input.prefix, financialYearOfDay(day, input.settings.financialYearStartMonth), input.sequence),
      creditNoteId: input.creditNoteId,
      creditNoteDate: day,
      invoiceId: input.invoiceId,
      refundMethod: input.refundMethod,
      reason: input.reason,
      lines: input.lines.map((l) => ({ invoiceItemId: l.line.invoiceItemId, quantity: l.quantity, resellable: l.resellable })),
      refundPaise,
    },
    refundPaise,
  };
}
