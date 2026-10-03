import { describe, expect, it } from "vitest";
import { formatPaise, paiseToRupeesText, rupeesToPaise } from "./money";

describe("rupeesToPaise", () => {
  it.each([
    ["799", 79_900],
    ["799.5", 79_950],
    ["799.50", 79_950],
    ["0.01", 1],
    ["0.1", 10],
    ["0", 0],
    [" 12 ", 1_200],
    ["1,49,999.00", 14_999_900],
    ["₹ 250", 25_000],
    ["999999999.99", 99_999_999_999],
    // The classic floating-point trap: 0.1 + 0.2 and 1.005 * 100.
    ["1.005".slice(0, 4), 100],
    ["19.99", 1_999],
    ["4.35", 435],
  ])("%j -> %i paise", (text, paise) => {
    expect(rupeesToPaise(text)).toBe(paise);
  });

  it.each(["", "abc", "-5", "1.005", "1.", ".5", "1e3", "12 34", "1000000000", "NaN", "Infinity", "0x10"])("refuses %j", (text) => {
    expect(rupeesToPaise(text)).toBeNull();
  });

  it("every amount from 0.00 to 20.00 converts exactly", () => {
    for (let p = 0; p <= 2_000; p++) {
      expect(rupeesToPaise(paiseToRupeesText(p))).toBe(p);
    }
  });
});

describe("display", () => {
  it.each([
    [0, "₹0.00"],
    [5, "₹0.05"],
    [79_950, "₹799.50"],
    [100_000, "₹1,000.00"],
    [14_999_900, "₹1,49,999.00"],
    [1_000_000_000, "₹1,00,00,000.00"],
    [-2_550, "-₹25.50"],
  ])("%i -> %s", (paise, text) => {
    expect(formatPaise(paise)).toBe(text);
  });

  it("refuses fractions of a paisa", () => {
    expect(() => paiseToRupeesText(1.5)).toThrow();
  });
});
