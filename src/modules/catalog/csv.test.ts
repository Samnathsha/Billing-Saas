import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";

describe("parseCsv", () => {
  it("reads plain rows", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("handles quotes, commas and quotes inside quotes, and empty fields", () => {
    expect(parseCsv('name,price\n"Shirt, blue",799\n"He said ""hi""",\n')).toEqual([
      ["name", "price"],
      ["Shirt, blue", "799"],
      ['He said "hi"', ""],
    ]);
  });

  it("handles CRLF, a missing last newline, Excel's byte-order mark, blank lines", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n\r\n3,4")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });

  it("keeps a line break inside quotes", () => {
    expect(parseCsv('a\n"two\nlines"\n')).toEqual([["a"], ["two\nlines"]]);
  });

  it("refuses an unclosed quote", () => {
    expect(() => parseCsv('a\n"open')).toThrow();
  });

  it("never interprets formulas", () => {
    expect(parseCsv("=SUM(A1)\n")).toEqual([["=SUM(A1)"]]);
  });
});
