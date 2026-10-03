import { describe, expect, it } from "vitest";
import { formatQuantity } from "./quantity";

describe("formatQuantity", () => {
  it.each([
    ["10.000", "10"],
    ["2.500", "2.5"],
    ["0.125", "0.125"],
    ["0.000", "0"],
    ["-0.000", "0"],
    ["-1.500", "-1.5"],
    ["007.010", "7.01"],
    ["99999999999.999", "99999999999.999"],
  ])("%s -> %s", (input, expected) => {
    expect(formatQuantity(input)).toBe(expected);
  });

  it("leaves anything unexpected as it is", () => {
    expect(formatQuantity("abc")).toBe("abc");
  });
});
