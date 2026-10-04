import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { returnAmounts } from "./return-maths";

describe("returnAmounts", () => {
  // The cash-sale line from the sales tests: 2 x ₹799 incl. 5%.
  const line = { taxablePaise: 152_190, cgstPaise: 3805, igstPaise: 0 };

  it("returning everything gives back exactly the line", () => {
    expect(returnAmounts(line, 2000n, 0n, 2000n)).toEqual({ taxablePaise: 152_190, cgstPaise: 3805, sgstPaise: 3805, igstPaise: 0, totalPaise: 159_800 });
  });

  it("one of two, then the other: halves that add up exactly", () => {
    const first = returnAmounts(line, 2000n, 0n, 1000n);
    const second = returnAmounts(line, 2000n, 1000n, 1000n);
    // 76095, 1902.5 -> 1903 ; then the rest: 76095, 1902
    expect(first).toEqual({ taxablePaise: 76_095, cgstPaise: 1903, sgstPaise: 1903, igstPaise: 0, totalPaise: 79_901 });
    expect(second).toEqual({ taxablePaise: 76_095, cgstPaise: 1902, sgstPaise: 1902, igstPaise: 0, totalPaise: 79_899 });
    expect(first.totalPaise + second.totalPaise).toBe(159_800);
  });

  it("IGST lines", () => {
    expect(returnAmounts({ taxablePaise: 76_095, cgstPaise: 0, igstPaise: 3805 }, 1000n, 0n, 1000n)).toMatchObject({ igstPaise: 3805, cgstPaise: 0, totalPaise: 79_900 });
  });

  it("refuses returning more than was sold, or nothing", () => {
    expect(() => returnAmounts(line, 2000n, 1500n, 1000n)).toThrow("more than was sold");
    expect(() => returnAmounts(line, 2000n, 0n, 0n)).toThrow();
  });

  it("any sequence of partial returns adds up exactly to the line, with no negative part", () => {
    fc.assert(
      fc.property(
        fc.record({ taxable: fc.integer({ min: 0, max: 10_000_000 }), cgst: fc.integer({ min: 0, max: 1_000_000 }), igst: fc.integer({ min: 0, max: 1_000_000 }) }),
        fc.array(fc.integer({ min: 1, max: 5000 }), { minLength: 1, maxLength: 8 }),
        (amounts, pieces) => {
          const sold = BigInt(pieces.reduce((a, b) => a + b, 0));
          let already = 0n;
          const sums = { taxable: 0, cgst: 0, igst: 0, total: 0 };
          for (const p of pieces) {
            const r = returnAmounts({ taxablePaise: amounts.taxable, cgstPaise: amounts.cgst, igstPaise: amounts.igst }, sold, already, BigInt(p));
            for (const v of Object.values(r)) expect(v).toBeGreaterThanOrEqual(0);
            sums.taxable += r.taxablePaise;
            sums.cgst += r.cgstPaise;
            sums.igst += r.igstPaise;
            sums.total += r.totalPaise;
            already += BigInt(p);
          }
          expect(sums).toEqual({ taxable: amounts.taxable, cgst: amounts.cgst, igst: amounts.igst, total: amounts.taxable + 2 * amounts.cgst + amounts.igst });
        },
      ),
      { numRuns: 3000 },
    );
  });
});
