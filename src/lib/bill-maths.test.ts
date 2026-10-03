import { describe, expect, it } from "vitest";
import { allocate, BillMathError, computeBill, discountWithinLimit, quantityToMilli, rateToE4, type BillInput, type BillLineInput } from "./bill-maths";

// Hand-checked cases. Property tests (any bill, the rules always hold) are
// in bill-maths.property.test.ts.

const line = (quantity: string, unitPricePaise: number, taxRate = "5", discountPaise = 0): BillLineInput => ({ quantity, unitPricePaise, taxRate, discountPaise });
const bill = (lines: BillLineInput[], extra: Partial<BillInput> = {}): BillInput => ({
  lines,
  pricesIncludeTax: true,
  chargesGst: true,
  interState: false,
  billDiscountPaise: 0,
  roundOff: false,
  ...extra,
});
const one = (l: BillLineInput, extra: Partial<BillInput> = {}) => computeBill(bill([l], extra)).lines[0];

describe("quantity and rate parsing", () => {
  it.each([
    ["1", 1000],
    ["2.5", 2500],
    ["0.001", 1],
    ["10.250", 10250],
  ])("quantity %s -> %i", (q, v) => {
    expect(quantityToMilli(q)).toBe(BigInt(v));
  });
  it.each(["", "-1", "1.2345", "1e2", " 1", "1,000"])("refuses quantity %j", (q) => {
    expect(() => quantityToMilli(q)).toThrow(BillMathError);
  });
  it.each([
    ["0", 0],
    ["5", 50_000],
    ["18", 180_000],
    ["0.25", 2_500],
    ["100", 1_000_000],
  ])("rate %s -> %i", (r, v) => {
    expect(rateToE4(r)).toBe(BigInt(v));
  });
  it.each(["100.0001", "-5", "18%", "x", "5.00001"])("refuses rate %j", (r) => {
    expect(() => rateToE4(r)).toThrow(BillMathError);
  });
});

describe("prices without GST (tax added on top)", () => {
  const ex = { pricesIncludeTax: false };
  it.each([
    // quantity, price, rate, taxable, cgst (= sgst), total
    ["1", 10_000, "18", 10_000, 900, 11_800],
    ["1", 99, "5", 99, 2, 103], // 2.475 -> 2 each half
    ["1", 100, "5", 100, 3, 106], // 2.5 -> 3 each half (half up)
    ["2.5", 4000, "5", 10_000, 250, 10_500], // metres
    ["0.333", 100, "5", 33, 1, 35], // 33.3 -> 33; 0.825 -> 1
    ["3", 3333, "12", 9999, 600, 11_199], // 599.94 -> 600
    ["1", 10_000, "0.25", 10_000, 13, 10_026], // 12.5 -> 13 each half
    ["1", 10_000, "0", 10_000, 0, 10_000],
    ["5", 0, "18", 0, 0, 0],
  ])("%s x %i paise @ %s%%", (q, price, rate, taxable, cgst, total) => {
    expect(one(line(q, price, rate), ex)).toMatchObject({ taxablePaise: taxable, cgstPaise: cgst, sgstPaise: cgst, igstPaise: 0, totalPaise: total });
  });

  it.each([
    // other state: IGST at the full rate
    ["1", 10_000, "18", 1800],
    ["1", 99, "5", 5], // 4.95 -> 5
    ["1", 10_000, "0.25", 25],
  ])("IGST: %s x %i @ %s%% = %i", (q, price, rate, igst) => {
    expect(one(line(q, price, rate), { ...ex, interState: true })).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: igst, taxablePaise: price * Number(q) });
  });
});

describe("prices including GST (tax taken out; the line stays the price paid)", () => {
  it.each([
    // quantity, price, rate, taxable, cgst (= sgst)
    ["1", 10_500, "5", 10_000, 250],
    ["1", 11_800, "18", 10_000, 900],
    ["1", 79_900, "5", 76_096, 1902], // net 76095.24 -> 76095; half 1902.38 -> 1902; taxable 79900 - 3804
    ["1", 100, "18", 84, 8], // net 84.75 -> 85; half 7.65 -> 8; taxable 100 - 16
    ["2", 50_000, "5", 95_238, 2381], // net 95238.10 -> 95238; half 2380.95 -> 2381; taxable 100000 - 4762
  ])("%s x %i paise @ %s%%", (q, price, rate, taxable, cgst) => {
    const l = one(line(q, price, rate));
    expect(l).toMatchObject({ taxablePaise: taxable, cgstPaise: cgst, sgstPaise: cgst, igstPaise: 0 });
    expect(l?.totalPaise).toBe(price * Number(q));
  });

  it.each([
    ["1", 79_900, "5", 76_095, 3805],
    ["1", 100, "18", 85, 15],
    ["1", 11_800, "18", 10_000, 1800],
  ])("IGST: %s x %i @ %s%%: taxable %i, IGST %i", (q, price, rate, taxable, igst) => {
    expect(one(line(q, price, rate), { interState: true })).toMatchObject({ taxablePaise: taxable, igstPaise: igst, totalPaise: price });
  });
});

describe("bill of supply (composition or unregistered business)", () => {
  it("charges no GST whatever the item's rate; the price is the total", () => {
    expect(one(line("2", 79_900, "18"), { chargesGst: false })).toMatchObject({ taxablePaise: 159_800, taxPaise: 0, totalPaise: 159_800 });
    expect(one(line("2", 79_900, "18"), { chargesGst: false, pricesIncludeTax: false })).toMatchObject({ taxPaise: 0, totalPaise: 159_800 });
  });
});

describe("discounts", () => {
  it("a line discount lowers the taxable value (Q6)", () => {
    // 2 x ₹500 incl. 5%, ₹50 off: 95000 -> net 90476.19 -> 90476; half 2261.9 -> 2262; taxable 95000 - 4524
    expect(one(line("2", 50_000, "5", 5000))).toMatchObject({ grossPaise: 100_000, lineDiscountPaise: 5000, taxablePaise: 90_476, cgstPaise: 2262, totalPaise: 95_000 });
  });

  it("a bill discount is shared in proportion, to the last paisa", () => {
    const result = computeBill(bill([line("1", 10_000, "0"), line("1", 20_000, "0"), line("1", 30_000, "0")], { billDiscountPaise: 1000 }));
    // 166.67, 333.33, 500 -> 166, 333, 500, and the leftover paisa to the largest fraction
    expect(result.lines.map((l) => l.billDiscountPaise)).toEqual([167, 333, 500]);
    expect(result).toMatchObject({ grossPaise: 60_000, discountPaise: 1000, totalPaise: 59_000 });
  });

  it("a bill discount after line discounts uses what is left of each line", () => {
    const result = computeBill(bill([line("1", 10_000, "0", 10_000), line("1", 10_000, "0")], { billDiscountPaise: 500 }));
    expect(result.lines.map((l) => l.billDiscountPaise)).toEqual([0, 500]);
    expect(result.totalPaise).toBe(9500);
  });

  it("everything free: 100% discount leaves no tax", () => {
    const result = computeBill(bill([line("1", 10_500), line("2", 2100)], { billDiscountPaise: 14_700 }));
    expect(result).toMatchObject({ totalPaise: 0, taxPaise: 0, taxablePaise: 0 });
  });

  it("refuses a discount bigger than the line or the bill", () => {
    expect(() => computeBill(bill([line("1", 1000, "5", 1001)]))).toThrow("Line 1: the discount is more than the line.");
    expect(() => computeBill(bill([line("1", 1000)], { billDiscountPaise: 1001 }))).toThrow("The bill discount cannot be more than the bill.");
  });

  it("limit check: the whole bill and each line's own discount (rule 8)", () => {
    const at = (discount: number, billDiscount = 0) => computeBill(bill([line("1", 10_000, "5", discount), line("1", 10_000)], { billDiscountPaise: billDiscount }));
    expect(discountWithinLimit(at(500), 500)).toBe(true); // 5% of that line
    expect(discountWithinLimit(at(501), 500)).toBe(false); // line over 5%, though the bill is at 2.5%
    expect(discountWithinLimit(at(0, 1000), 500)).toBe(true); // 1000 of 20000 = 5%
    expect(discountWithinLimit(at(0, 1001), 500)).toBe(false);
    expect(discountWithinLimit(at(400, 601), 500)).toBe(false); // 1001 in total
    expect(discountWithinLimit(at(10_000), null)).toBe(true); // manager: no limit
    expect(discountWithinLimit(at(0), 0)).toBe(true);
    expect(discountWithinLimit(at(1), 0)).toBe(false);
  });
});

describe("allocate", () => {
  it.each([
    [2, [1, 1, 1], [1, 1, 0]], // ties: earlier line first
    [1, [1, 2], [0, 1]], // fractions 1/3 and 2/3: the larger fraction wins
    [3, [1, 1, 1], [1, 1, 1]],
    [0, [5, 7], [0, 0]],
    [12, [5, 7], [5, 7]],
    [10, [0, 7, 3], [0, 7, 3]],
    [1, [3, 3], [1, 0]],
  ])("%i over %j -> %j", (total, weights, expected) => {
    expect(allocate(BigInt(total), weights.map((w) => BigInt(w)))).toEqual(expected.map((e) => BigInt(e)));
  });

  it("never gives a line more than its weight, and always adds up", () => {
    for (let total = 0n; total <= 30n; total += 1n) {
      const weights = [1n, 2n, 3n, 4n, 5n, 6n, 9n];
      const shares = allocate(total, weights);
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(total);
      shares.forEach((s, i) => {
        expect(s >= 0n && s <= (weights[i] ?? 0n)).toBe(true);
      });
    }
  });
});

describe("the bill", () => {
  it("adds the lines and splits the tax", () => {
    const result = computeBill(bill([line("2", 79_900, "5"), line("1", 11_800, "18")]));
    expect(result.lines.map((l) => l.totalPaise)).toEqual([159_800, 11_800]);
    expect(result.totalPaise).toBe(171_600);
    expect(result.taxablePaise + result.taxPaise).toBe(result.totalPaise);
    expect(result.cgstPaise).toBe(result.sgstPaise);
    expect(result.payablePaise).toBe(171_600);
  });

  it.each([
    [11_850, 50, 11_900],
    [11_849, -49, 11_800],
    [11_800, 0, 11_800],
    [1, -1, 0],
    [50, 50, 100],
  ])("round-off: %i -> %i -> %i", (price, roundOff, payable) => {
    const result = computeBill(bill([line("1", price, "0")], { roundOff: true }));
    expect(result).toMatchObject({ totalPaise: price, roundOffPaise: roundOff, payablePaise: payable });
  });

  it("refuses bad input", () => {
    expect(() => computeBill(bill([]))).toThrow("Add at least one item.");
    expect(() => computeBill(bill([line("0", 100)]))).toThrow("Line 1: enter a quantity above zero.");
    expect(() => computeBill(bill([line("1", -1)]))).toThrow(BillMathError);
    expect(() => computeBill(bill([line("1", 1.5)]))).toThrow(BillMathError);
    expect(() => computeBill(bill([line("1", 100, "5", -1)]))).toThrow(BillMathError);
    expect(() => computeBill(bill([line("1", 100, "101")]))).toThrow(BillMathError);
    expect(() => computeBill(bill(Array.from({ length: 501 }, () => line("1", 1))))).toThrow("A bill can have at most 500 lines.");
  });

  it("refuses a bill above ₹100 crore", () => {
    expect(() => computeBill(bill([line("99999", 99_999_999)], { pricesIncludeTax: false }))).toThrow("This bill total is too large.");
    expect(computeBill(bill([line("1000", 100_000_000)])).totalPaise).toBe(100_000_000_000);
  });
});
