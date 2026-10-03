import { describe, expect, it } from "vitest";
import { purchaseLineAmounts, quantityToMilli, rateToE4 } from "./maths";

describe("quantityToMilli", () => {
  it.each([
    ["1", 1000n],
    ["2.5", 2500n],
    ["0.001", 1n],
    ["10.25", 10250n],
    ["99999999999.999", 99999999999999n],
  ])("%s -> %s", (q, expected) => {
    expect(quantityToMilli(q)).toBe(expected);
  });

  it.each(["", "-1", "1.2345", "1e3", "abc", " 1"])("refuses %j", (q) => {
    expect(() => quantityToMilli(q)).toThrow();
  });
});

describe("rateToE4", () => {
  it.each([
    ["0", 0n],
    ["5", 50000n],
    ["18", 180000n],
    ["0.25", 2500n],
    ["1.5", 15000n],
    ["100", 1000000n],
  ])("%s -> %s", (r, expected) => {
    expect(rateToE4(r)).toBe(expected);
  });

  it.each(["100.0001", "101", "-5", "18.00001", "x"])("refuses %j", (r) => {
    expect(() => rateToE4(r)).toThrow();
  });
});

describe("purchaseLineAmounts", () => {
  const line = (quantity: string, unitPricePaise: number, taxRate: string, costBasis: "excludes_tax" | "includes_tax" = "excludes_tax") =>
    purchaseLineAmounts({ quantity, unitPricePaise, taxRate, costBasis });

  it.each([
    // quantity, price, rate, subtotal, tax, total, cost (excl. tax)
    ["10", 50000, "18", 500000, 90000, 590000, "50000.0000"],
    ["1", 99, "5", 99, 5, 104, "99.0000"], // 4.95 -> 5
    ["1", 10, "5", 10, 1, 11, "10.0000"], // 0.5 -> 1 (half up)
    ["1", 9, "5", 9, 0, 9, "9.0000"], // 0.45 -> 0
    ["3", 3333, "12", 9999, 1200, 11199, "3333.0000"], // 1199.88 -> 1200
    ["2.5", 4000, "5", 10000, 500, 10500, "4000.0000"],
    ["0.333", 100, "0", 33, 0, 33, "99.0991"], // 33.3 -> 33; cost 33 / 0.333
    ["1.5", 333, "0.25", 500, 1, 501, "333.3333"], // 499.5 -> 500; 1.25 -> 1
    ["7", 0, "18", 0, 0, 0, "0.0000"], // free goods
    ["3", 100, "0", 300, 0, 300, "100.0000"],
  ])("%s x %i @ %s%%", (q, price, rate, subtotal, tax, total, cost) => {
    expect(line(q, price, rate)).toEqual({ subtotalPaise: subtotal, taxPaise: tax, totalPaise: total, unitCostPaise: cost });
  });

  it("composition / unregistered: cost includes the GST paid", () => {
    expect(line("10", 50000, "18", "includes_tax")).toEqual({ subtotalPaise: 500000, taxPaise: 90000, totalPaise: 590000, unitCostPaise: "59000.0000" });
    expect(line("3", 100, "5", "includes_tax").unitCostPaise).toBe("105.0000"); // 315 / 3
    expect(line("7", 100, "5", "includes_tax")).toEqual({ subtotalPaise: 700, taxPaise: 35, totalPaise: 735, unitCostPaise: "105.0000" });
    expect(line("3", 1, "18", "includes_tax").unitCostPaise).toBe("1.3333"); // 3 + 0.54 -> 1 = 4 / 3
  });

  it("totals always add up and stay whole paise", () => {
    for (let price = 0; price < 2000; price += 37) {
      for (const rate of ["0", "0.25", "3", "5", "12", "18", "28", "40"]) {
        for (const q of ["1", "2", "3.5", "0.125", "17"]) {
          const a = line(q, price, rate);
          expect(a.totalPaise).toBe(a.subtotalPaise + a.taxPaise);
          expect(Number.isSafeInteger(a.subtotalPaise) && Number.isSafeInteger(a.taxPaise)).toBe(true);
          expect(a.unitCostPaise).toMatch(/^\d+\.\d{4}$/);
        }
      }
    }
  });

  it("large bills stay exact", () => {
    // 99,999 x 99,999,999 paise = 9,999,899,900,001; GST 18% = ...982,000.18
    expect(line("99999", 99999999, "18")).toEqual({
      subtotalPaise: 9999899900001,
      taxPaise: 1799981982000,
      totalPaise: 11799881882001,
      unitCostPaise: "99999999.0000",
    });
  });

  it("refuses a zero quantity and a negative price", () => {
    expect(() => line("0", 100, "5")).toThrow();
    expect(() => line("1", -1, "5")).toThrow();
    expect(() => line("1", 1.5, "5")).toThrow();
  });
});
