import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv-write";

describe("csvCell", () => {
  it.each([
    ["Cotton Shirt", '"Cotton Shirt"'],
    ['Say "hi"', '"Say ""hi"""'],
    ["a,b", '"a,b"'],
    ["line\nbreak", '"line\nbreak"'],
    ["", '""'],
  ])("%j -> %s", (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it.each([
    ["=HYPERLINK(\"http://evil\")", "\"'=HYPERLINK(\"\"http://evil\"\")\""],
    ["+1+1", "\"'+1+1\""],
    ["-2+3", "\"'-2+3\""],
    ["@SUM(A1)", "\"'@SUM(A1)\""],
    ["\tTAB", "\"'\tTAB\""],
  ])("defuses a formula: %j", (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it("amounts as text stay numbers, including negative ones", () => {
    expect(csvCell("-799.50")).toBe('"-799.50"');
    expect(csvCell("-12")).toBe('"-12"');
    expect(csvCell("-1-1")).toBe("\"'-1-1\"");
  });

  it("numbers are written as they are, including negative ones", () => {
    expect(csvCell(-799.5)).toBe('"-799.5"');
    expect(csvCell(0)).toBe('"0"');
  });
});

describe("toCsv", () => {
  it("rows with CRLF and a byte-order mark", () => {
    expect(toCsv([["Day", "Sales (₹)"], ["2026-10-03", "1598.00"]])).toBe('﻿"Day","Sales (₹)"\r\n"2026-10-03","1598.00"\r\n');
  });
});
