import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeBill, discountWithinLimit, type BillInput } from "./bill-maths";

// Property tests: thousands of random bills; the rules must hold for every
// one of them. fast-check shrinks any failure to the smallest bill that
// breaks a rule.

const RATES = ["0", "0.25", "1", "1.5", "3", "5", "12", "18", "28", "40"];
const RUNS = { numRuns: 3000 };

const gross = (milli: number, price: number): number => Number((2n * BigInt(milli) * BigInt(price) + 1000n) / 2000n);

const lineArb = fc
  .record({
    milli: fc.integer({ min: 1, max: 100_000 }), // 0.001 to 100 units
    price: fc.integer({ min: 0, max: 5_000_000 }), // up to ₹50,000
    rate: fc.constantFrom(...RATES),
    discountPerMille: fc.integer({ min: 0, max: 1000 }),
  })
  .map(({ milli, price, rate, discountPerMille }) => {
    const g = gross(milli, price);
    return {
      quantity: `${String(Math.floor(milli / 1000))}.${String(milli % 1000).padStart(3, "0")}`,
      unitPricePaise: price,
      taxRate: rate,
      discountPaise: Math.floor((g * discountPerMille) / 1000),
    };
  });

const billArb = fc
  .record({
    lines: fc.array(lineArb, { minLength: 1, maxLength: 15 }),
    pricesIncludeTax: fc.boolean(),
    chargesGst: fc.boolean(),
    interState: fc.boolean(),
    roundOff: fc.boolean(),
    billDiscountPerMille: fc.integer({ min: 0, max: 1000 }),
  })
  .map(({ billDiscountPerMille, ...rest }): BillInput => {
    const left = rest.lines.reduce((sum, l) => {
      const milli = Number(l.quantity.replace(".", ""));
      return sum + gross(milli, l.unitPricePaise) - l.discountPaise;
    }, 0);
    return { ...rest, billDiscountPaise: Math.floor((left * billDiscountPerMille) / 1000) };
  });

describe("bill maths: rules that hold for every bill", () => {
  it("line totals add up exactly to the bill total; the bill parts add up", () => {
    fc.assert(
      fc.property(billArb, (input) => {
        const b = computeBill(input);
        const sum = (pick: (l: (typeof b.lines)[number]) => number) => b.lines.reduce((s, l) => s + pick(l), 0);
        expect(sum((l) => l.totalPaise)).toBe(b.totalPaise);
        expect(b.taxablePaise + b.taxPaise).toBe(b.totalPaise);
        expect(b.cgstPaise + b.sgstPaise + b.igstPaise).toBe(b.taxPaise);
        expect(b.grossPaise - b.discountPaise).toBe(sum((l) => l.grossPaise - l.lineDiscountPaise - l.billDiscountPaise));
        expect(b.payablePaise).toBe(b.totalPaise + b.roundOffPaise);
      }),
      RUNS,
    );
  });

  it("every line: whole non-negative paise, equal CGST and SGST, IGST only between states", () => {
    fc.assert(
      fc.property(billArb, (input) => {
        for (const l of computeBill(input).lines) {
          for (const value of Object.values(l)) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
          expect(l.taxablePaise + l.taxPaise).toBe(l.totalPaise);
          expect(l.cgstPaise).toBe(l.sgstPaise);
          if (input.interState) expect(l.cgstPaise).toBe(0);
          else expect(l.igstPaise).toBe(0);
          if (!input.chargesGst) expect(l.taxPaise).toBe(0);
        }
      }),
      RUNS,
    );
  });

  it("prices including GST: each line costs exactly the price after discounts; excluding GST: that is the taxable value", () => {
    fc.assert(
      fc.property(billArb, (input) => {
        for (const l of computeBill(input).lines) {
          const amount = l.grossPaise - l.lineDiscountPaise - l.billDiscountPaise;
          expect(amount).toBeGreaterThanOrEqual(0);
          if (input.pricesIncludeTax || !input.chargesGst) expect(l.totalPaise).toBe(amount);
          else expect(l.taxablePaise).toBe(amount);
        }
      }),
      RUNS,
    );
  });

  it("GST is never more than 2 paise away from the exact rate (one per half)", () => {
    fc.assert(
      fc.property(billArb, (input) => {
        computeBill(input).lines.forEach((l, i) => {
          const rate = input.chargesGst ? Number(input.lines[i]?.taxRate ?? "0") : 0;
          // exact tax on the line's taxable value, in thousandths of a paisa
          const exact = (l.taxablePaise * rate * 1000) / 100;
          expect(Math.abs(l.taxPaise * 1000 - exact)).toBeLessThanOrEqual(2000 + 1);
        });
      }),
      RUNS,
    );
  });

  it("the bill discount is shared out completely, and no line gets more than it has left", () => {
    fc.assert(
      fc.property(billArb, (input) => {
        const b = computeBill(input);
        expect(b.lines.reduce((s, l) => s + l.billDiscountPaise, 0)).toBe(input.billDiscountPaise);
        for (const l of b.lines) expect(l.billDiscountPaise).toBeLessThanOrEqual(l.grossPaise - l.lineDiscountPaise);
      }),
      RUNS,
    );
  });

  it("round-off lands on a whole rupee and moves at most 50 paise", () => {
    fc.assert(
      fc.property(billArb, (input) => {
        const b = computeBill({ ...input, roundOff: true });
        expect(b.payablePaise % 100).toBe(0);
        expect(b.roundOffPaise).toBeGreaterThanOrEqual(-49);
        expect(b.roundOffPaise).toBeLessThanOrEqual(50);
      }),
      RUNS,
    );
  });

  it("the same bill always gives the same answer", () => {
    fc.assert(
      fc.property(billArb, (input) => {
        expect(computeBill(structuredClone(input))).toEqual(computeBill(input));
      }),
      { numRuns: 500 },
    );
  });

  it("the discount limit: allowed at a limit means allowed at any higher limit; no discount is always allowed", () => {
    fc.assert(
      fc.property(billArb, fc.integer({ min: 0, max: 10_000 }), (input, limit) => {
        const b = computeBill(input);
        if (discountWithinLimit(b, limit)) expect(discountWithinLimit(b, Math.min(limit + 1, 10_000))).toBe(true);
        expect(discountWithinLimit(b, 10_000)).toBe(true);
        expect(discountWithinLimit(computeBill({ ...input, billDiscountPaise: 0, lines: input.lines.map((l) => ({ ...l, discountPaise: 0 })) }), 0)).toBe(true);
      }),
      RUNS,
    );
  });
});
