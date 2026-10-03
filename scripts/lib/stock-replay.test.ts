import { describe, expect, it } from "vitest";
import { compare, fromScaled, replay, toScaled, type ReplayMovement } from "./stock-replay";

const V = "v1";
const B = "b1";
let seq = 0;
const m = (movementType: string, quantity: string, unitCostPaise = "0"): ReplayMovement => ({ variantId: V, branchId: B, movementType, quantity, unitCostPaise, seq: ++seq });
const result = (moves: ReplayMovement[]) => {
  const state = replay(moves).get(`${V}|${B}`);
  return state === undefined ? undefined : { quantity: fromScaled(state.quantity, 3), average: fromScaled(state.average, 4), wentBelowZero: state.wentBelowZero };
};

describe("toScaled / fromScaled", () => {
  it.each([
    ["10.000", 3, 10000n],
    ["-1.000", 3, -1000n],
    ["2.5", 3, 2500n],
    ["1333.3333", 4, 13333333n],
    ["0", 4, 0n],
    ["99999999999.999", 3, 99999999999999n],
  ])("%s at %i decimals", (text, scale, value) => {
    expect(toScaled(text, scale)).toBe(value);
  });

  it("refuses extra decimals and junk instead of rounding", () => {
    expect(() => toScaled("1.23456", 4)).toThrow();
    expect(() => toScaled("1e3", 3)).toThrow();
    expect(() => toScaled("", 3)).toThrow();
    expect(toScaled("1.230000", 4)).toBe(12300n);
  });

  it("round trips", () => {
    expect(fromScaled(-1500n, 3)).toBe("-1.500");
    expect(fromScaled(13333333n, 4)).toBe("1333.3333");
    expect(fromScaled(5n, 4)).toBe("0.0005");
  });
});

describe("replay matches the database rules", () => {
  it("weighted average: 2 at ₹10 + 1 at ₹20 = 1333.3333", () => {
    expect(result([m("OPENING_STOCK", "2", "1000"), m("PURCHASE_IN", "1", "2000")])).toEqual({ quantity: "3.000", average: "1333.3333", wentBelowZero: false });
  });

  it("stock out keeps the average; all out sets nothing left but keeps the average until stock comes in", () => {
    expect(result([m("PURCHASE_IN", "3", "1000"), m("SALE_OUT", "-2", "1000")])).toEqual({ quantity: "1.000", average: "1000.0000", wentBelowZero: false });
    // Out does not touch the average (SQL takeOut); the next stock in starts from 0 quantity.
    expect(result([m("PURCHASE_IN", "1", "1000"), m("SALE_OUT", "-1", "1000"), m("PURCHASE_IN", "1", "500")])).toEqual({ quantity: "1.000", average: "500.0000", wentBelowZero: false });
  });

  it("rounds half away from zero at 4 decimals", () => {
    // (1*0 + 2*1)/3 = 0.6666.. -> 0.6667
    expect(result([m("PURCHASE_IN", "1", "0"), m("PURCHASE_IN", "2", "1")])?.average).toBe("0.6667");
    // (1*1 + 1*0.0001)/2 = 0.50005 -> 0.5001
    expect(result([m("PURCHASE_IN", "1", "1"), m("PURCHASE_IN", "1", "0.0001")])?.average).toBe("0.5001");
    // (3*0 + 1*0.0002)/4 = 0.00005 -> 0.0001
    expect(result([m("PURCHASE_IN", "3", "0"), m("PURCHASE_IN", "1", "0.0002")])?.average).toBe("0.0001");
  });

  it("voiding a purchase restores the earlier average", () => {
    const moves = [m("OPENING_STOCK", "2", "1000"), m("PURCHASE_IN", "1", "2000"), m("VOID_REVERSAL", "-1", "2000")];
    expect(result(moves)).toEqual({ quantity: "2.000", average: "1000.0000", wentBelowZero: false });
  });

  it("a reversal that empties the item leaves average 0; one that would go negative is floored at 0", () => {
    expect(result([m("PURCHASE_IN", "1", "2000"), m("VOID_REVERSAL", "-1", "2000")])).toEqual({ quantity: "0.000", average: "0.0000", wentBelowZero: false });
    // 1 left at avg 1000 after selling; reversing 1 unit bought at 3000 is impossible (would go below zero).
    expect(result([m("PURCHASE_IN", "1", "1000"), m("PURCHASE_IN", "1", "3000"), m("SALE_OUT", "-1", "2000"), m("VOID_REVERSAL", "-1", "3000")])).toEqual({
      quantity: "0.000",
      average: "0.0000",
      wentBelowZero: false,
    });
    // 2 at 1500, reversing 1 recorded at 4000: (3000 - 4000) / 1 < 0 -> 0
    expect(result([m("PURCHASE_IN", "1", "1500"), m("PURCHASE_IN", "1", "1500"), m("VOID_REVERSAL", "-1", "4000")])?.average).toBe("0.0000");
    // 3 at 1500, reversing 1 at 4000: (4500 - 4000) / 2 = 250
    expect(result([m("PURCHASE_IN", "3", "1500"), m("VOID_REVERSAL", "-1", "4000")])?.average).toBe("250.0000");
  });

  it("fractions (metres) stay exact", () => {
    expect(result([m("PURCHASE_IN", "2.5", "4000"), m("PURCHASE_IN", "0.125", "8000"), m("ADJUSTMENT_OUT", "-0.375", "4190.4762")])).toEqual({
      quantity: "2.250",
      average: "4190.4762",
      wentBelowZero: false,
    });
  });

  it("notices stock that went below zero", () => {
    expect(result([m("PURCHASE_IN", "1", "100"), m("SALE_OUT", "-2", "100"), m("PURCHASE_IN", "5", "100")])?.wentBelowZero).toBe(true);
  });

  it("keeps items and branches apart", () => {
    const state = replay([
      { variantId: "a", branchId: "x", movementType: "PURCHASE_IN", quantity: "1", unitCostPaise: "100", seq: 1 },
      { variantId: "a", branchId: "y", movementType: "PURCHASE_IN", quantity: "2", unitCostPaise: "300", seq: 2 },
      { variantId: "b", branchId: "x", movementType: "PURCHASE_IN", quantity: "3", unitCostPaise: "500", seq: 3 },
    ]);
    expect([...state.entries()].map(([k, s]) => [k, s.quantity, s.average])).toEqual([
      ["a|x", 1000n, 1000000n],
      ["a|y", 2000n, 3000000n],
      ["b|x", 3000n, 5000000n],
    ]);
  });
});

describe("compare", () => {
  const expected = replay([m("PURCHASE_IN", "3", "1000")]);
  const stored = (quantity: string, averageCostPaise: string) => [{ variantId: V, branchId: B, quantity, averageCostPaise }];

  it("no differences when the stored balance matches", () => {
    expect(compare(expected, stored("3.000", "1000.0000"))).toEqual([]);
  });

  it("reports a wrong quantity and a wrong average", () => {
    expect(compare(expected, stored("4.000", "999.9999"))).toEqual([
      { variantId: V, branchId: B, problem: "quantity", expected: "3.000", found: "4.000" },
      { variantId: V, branchId: B, problem: "average_cost", expected: "1000.0000", found: "999.9999" },
    ]);
  });

  it("reports a missing balance row and a balance with stock but no history", () => {
    expect(compare(expected, [])).toEqual([{ variantId: V, branchId: B, problem: "no_balance_row", expected: "3.000", found: "missing" }]);
    expect(compare(new Map(), [{ variantId: "z", branchId: B, quantity: "2.000", averageCostPaise: "0.0000" }])).toEqual([
      { variantId: "z", branchId: B, problem: "quantity", expected: "0.000", found: "2.000" },
    ]);
    expect(compare(new Map(), [{ variantId: "z", branchId: B, quantity: "0.000", averageCostPaise: "0.0000" }])).toEqual([]);
  });
});
