import { describe, expect, it } from "vitest";
import { makeOfflineReturn, makeOfflineSale, priceOfflineBill, refundFor, type OfflineCartLine } from "./offline-bill";
import type { TaxRateRow } from "./tax-pick";

// The till's own maths for offline bills and returns (decision 0006). The
// server works the same bill out again and refuses it if it differs, so
// these must match the server's rules exactly (tests/integration/
// offline-sync.test.ts sends what this makes).

const settings = { pricesIncludeTax: true, chargesGst: true, timeZone: "Asia/Kolkata", financialYearStartMonth: 4 };
const row = (rate: string, min: number | null, max: number | null): TaxRateRow => ({ label: `GST ${rate}%`, rate, priceMinPaise: min, priceMaxPaise: max, effectiveFrom: "2017-07-01", effectiveTo: null });
// Clothing: 5% below ₹1,000 a piece, 12% from ₹1,000 (open question 2).
const rates = { cloth: [row("5", null, 100_000), row("12", 100_000, null)] };
const shirt = { variantId: "v1", name: "Shirt", pricePaise: 79_900, taxCategory: "cloth", trackSerial: false };
const jacket = { variantId: "v2", name: "Jacket", pricePaise: 104_900, taxCategory: "cloth", trackSerial: false };
const line = (item: typeof shirt, quantity = "1", discountPaise = 0): OfflineCartLine => ({ item, quantity, discountPaise, serial: null });

describe("an offline bill", () => {
  it("2 x ₹799 at 5% included: ₹1,598.00, CGST = SGST = ₹38.05", () => {
    const { bill, rates: chosen } = priceOfflineBill(settings, rates, "2026-10-04", [line(shirt, "2")], 0);
    expect(bill).toMatchObject({ payablePaise: 159_800, cgstPaise: 3_805, sgstPaise: 3_805, roundOffPaise: 0 });
    expect(chosen).toEqual([{ label: "GST 5%", rate: "5" }]);
  });

  it("the rate follows the price per piece after discounts: ₹1,049 with ₹60 off drops to 5%", () => {
    expect(priceOfflineBill(settings, rates, "2026-10-04", [line(jacket)], 0).rates[0]?.rate).toBe("12");
    expect(priceOfflineBill(settings, rates, "2026-10-04", [line(jacket, "1", 6_000)], 0).rates[0]?.rate).toBe("5");
    // A bill discount shared onto the line counts too.
    expect(priceOfflineBill(settings, rates, "2026-10-04", [line(jacket)], 6_000).rates[0]?.rate).toBe("5");
  });

  it("a bill of supply charges no GST", () => {
    const { bill, rates: chosen } = priceOfflineBill({ ...settings, chargesGst: false }, rates, "2026-10-04", [line(shirt)], 0);
    expect(bill.taxPaise).toBe(0);
    expect(chosen[0]).toEqual({ label: "No GST (bill of supply)", rate: "0" });
  });

  it("no usable rate: the till cannot make the bill", () => {
    expect(() => priceOfflineBill(settings, {}, "2026-10-04", [line(shirt)], 0)).toThrow();
  });

  it("numbered from the till's series in the business's financial year and day", () => {
    // 31 March 2027 20:00 UTC is 1 April 2027 in India: the new year.
    const { op } = makeOfflineSale({
      opId: "op",
      invoiceId: "inv",
      lineIds: ["l1"],
      madeBy: "u",
      at: new Date("2027-03-31T20:00:00Z"),
      settings,
      taxRates: rates,
      prefix: "T1",
      sequence: 7,
      lines: [line(shirt)],
      billDiscountPaise: 0,
      payments: [{ method: "cash", amountPaise: 79_900, reference: null }],
    });
    expect(op).toMatchObject({ number: "T1/27-28/00007", invoiceDate: "2027-04-01", payablePaise: 79_900, lines: [{ lineId: "l1", taxRate: "5", taxLabel: "GST 5%", unitPricePaise: 79_900 }] });
  });
});

describe("an offline return", () => {
  // One line: 3 pieces, taxable ₹2,282.86, CGST ₹57.07 each (₹2,397.00).
  const kept = { invoiceItemId: "i1", sold: "3.000", returned: "0.000", taxablePaise: 228_286, cgstPaise: 5_707, igstPaise: 0 };

  it("returning everything in parts gives back exactly the line", () => {
    const first = refundFor([{ line: kept, quantity: "1" }]);
    const second = refundFor([{ line: { ...kept, returned: "1.000" }, quantity: "1" }]);
    const third = refundFor([{ line: { ...kept, returned: "2.000" }, quantity: "1" }]);
    expect(first.totalPaise + second.totalPaise + third.totalPaise).toBe(228_286 + 2 * 5_707);
    expect(first.refundPaise % 100).toBe(0);
  });

  it("numbered from the till's credit-note series", () => {
    const { op, refundPaise } = makeOfflineReturn({
      opId: "op",
      creditNoteId: "cn",
      madeBy: "u",
      at: new Date("2026-10-04T06:00:00Z"),
      settings,
      prefix: "T1R",
      sequence: 2,
      invoiceId: "inv",
      lines: [{ line: kept, quantity: "3", resellable: true }],
      refundMethod: "cash",
      reason: "Wrong size",
    });
    expect(op).toMatchObject({ number: "T1R/26-27/00002", creditNoteDate: "2026-10-04", refundPaise: 239_700, lines: [{ invoiceItemId: "i1", quantity: "3", resellable: true }] });
    expect(refundPaise).toBe(239_700);
  });
});
