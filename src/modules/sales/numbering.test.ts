import { describe, expect, it } from "vitest";
import { financialYearLabel, financialYearStart, formatDocumentNumber, MAX_LENGTH } from "./numbering";

const KOLKATA = "Asia/Kolkata";

describe("financial year (April start, India time)", () => {
  it.each([
    ["2026-04-01T00:00:00+05:30", 2026, "first moment of 1 April in India"],
    ["2026-03-31T23:59:59+05:30", 2025, "last moment of 31 March in India"],
    // 31 March 19:00 in London is already 1 April in India.
    ["2026-03-31T18:30:00Z", 2026, "31 March 18:30 UTC = 1 April 00:00 India"],
    ["2026-03-31T18:29:59Z", 2025, "one second earlier"],
    ["2026-12-31T12:00:00+05:30", 2026, "December"],
    ["2027-01-15T12:00:00+05:30", 2026, "January belongs to the year that began in April"],
  ])("%s -> %i (%s)", (iso, expected) => {
    expect(financialYearStart(new Date(iso), KOLKATA, 4)).toBe(expected);
  });

  it("labels the year as YY-YY, also across a century", () => {
    expect(financialYearLabel(2026, 4)).toBe("26-27");
    expect(financialYearLabel(2099, 4)).toBe("99-00");
    expect(financialYearLabel(2009, 4)).toBe("09-10");
  });

  it("a January start is the plain year", () => {
    expect(financialYearStart(new Date("2026-01-01T00:00:00+05:30"), KOLKATA, 1)).toBe(2026);
    expect(financialYearLabel(2026, 1)).toBe("2026");
  });
});

describe("bill numbers: PREFIX/YY-YY/NNNNN", () => {
  it("formats with five digits", () => {
    expect(formatDocumentNumber("INV", "26-27", 1)).toBe("INV/26-27/00001");
    expect(formatDocumentNumber("CN", "26-27", 42)).toBe("CN/26-27/00042");
    expect(formatDocumentNumber("ABCD", "26-27", 99_999)).toBe("ABCD/26-27/99999");
  });

  it("the longest possible number is exactly the 16-character GST limit", () => {
    expect(formatDocumentNumber("ABCD", "26-27", 99_999)).toHaveLength(MAX_LENGTH);
  });

  it.each([0, -1, 100_000, 1.5, Number.NaN])("refuses number %s", (n) => {
    expect(() => formatDocumentNumber("INV", "26-27", n)).toThrow();
  });

  it.each(["", "INVOI", "inv", "IN-V", "IN/V", "IN V", "₹"])("refuses prefix %j", (prefix) => {
    expect(() => formatDocumentNumber(prefix, "26-27", 1)).toThrow();
  });
});
