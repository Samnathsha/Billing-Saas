import { describe, expect, it } from "vitest";
import { pickTaxRate, TaxRateError, type TaxRateRow } from "./rates";

const row = (rate: string, from: string, to: string | null = null, min: number | null = null, max: number | null = null): TaxRateRow => ({
  label: `TEST ${rate}%`,
  rate,
  priceMinPaise: min,
  priceMaxPaise: max,
  effectiveFrom: from,
  effectiveTo: to,
});

const codeOf = (work: () => unknown): string => {
  try {
    work();
    return "ok";
  } catch (error) {
    if (error instanceof TaxRateError) return error.code;
    throw error;
  }
};

describe("pickTaxRate", () => {
  it("a single open-ended rate applies from its first day", () => {
    const rows = [row("5", "2017-07-01")];
    expect(pickTaxRate(rows, "c", "2017-07-01", 100).rate).toBe("5");
    expect(pickTaxRate(rows, "c", "2026-10-03", 100).rate).toBe("5");
    expect(codeOf(() => pickTaxRate(rows, "c", "2017-06-30", 100))).toBe("NO_RATE");
  });

  it("a rate change: the old rate up to the day before, the new rate from the day", () => {
    const rows = [row("12", "2017-07-01", "2025-09-22"), row("5", "2025-09-22")];
    expect(pickTaxRate(rows, "c", "2025-09-21", 100).rate).toBe("12");
    expect(pickTaxRate(rows, "c", "2025-09-22", 100).rate).toBe("5");
  });

  it("price slabs per piece: below the limit one rate, at or above it the other", () => {
    const rows = [row("5", "2017-07-01", null, null, 250_000), row("18", "2017-07-01", null, 250_000, null)];
    expect(pickTaxRate(rows, "c", "2026-10-03", 249_999).rate).toBe("5");
    expect(pickTaxRate(rows, "c", "2026-10-03", 250_000).rate).toBe("18");
    expect(pickTaxRate(rows, "c", "2026-10-03", 0).rate).toBe("5");
  });

  it("no rate or overlapping rates are refused, never guessed", () => {
    expect(codeOf(() => pickTaxRate([], "c", "2026-10-03", 100))).toBe("NO_RATE");
    expect(codeOf(() => pickTaxRate([row("5", "2017-07-01"), row("18", "2020-01-01")], "c", "2026-10-03", 100))).toBe("SEVERAL_RATES");
    expect(codeOf(() => pickTaxRate([row("5", "2017-07-01", null, null, 1000), row("18", "2017-07-01", null, 500, null)], "c", "2026-10-03", 700))).toBe("SEVERAL_RATES");
  });
});
