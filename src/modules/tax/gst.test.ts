import { describe, expect, it } from "vitest";
import { GST_STATES, gstinCheckChar, gstinProblem, needsGstin, normaliseGstin } from "./gst";

// A widely published sample GSTIN (Maharashtra), used as the known-good case.
const SAMPLE = "27AAPFU0939F1ZV";

// Builds a GSTIN with a correct check character from its first 14.
const withCheck = (first14: string): string => first14 + gstinCheckChar(first14);

describe("GSTIN check", () => {
  it("accepts the published sample", () => {
    expect(gstinProblem(SAMPLE)).toBeNull();
  });

  it("catches a single mistyped character anywhere", () => {
    for (let i = 0; i < 15; i++) {
      const original = SAMPLE.charAt(i);
      const replacement = /[0-9]/.test(original) ? String((Number(original) + 1) % 10) : original === "A" ? "B" : "A";
      const typo = SAMPLE.slice(0, i) + replacement + SAMPLE.slice(i + 1);
      expect(gstinProblem(typo), `position ${String(i + 1)}`).not.toBeNull();
    }
  });

  it("catches two swapped neighbouring characters", () => {
    const swapped = "27AAPFU0939F1VZ";
    expect(gstinProblem(swapped)).not.toBeNull();
    const swappedDigits = "27AAPFU9039F1ZV";
    expect(gstinProblem(swappedDigits)).not.toBeNull();
  });

  it.each([
    ["too short", "27AAPFU0939F1Z"],
    ["too long", "27AAPFU0939F1ZVX"],
    ["lower case", "27aapfu0939f1zv"],
    ["spaces", "27AAPFU 0939F1ZV"],
    ["no Z in place 14", "27AAPFU0939F1AV"],
    ["entity number 0", "27AAPFU0939F0ZV"],
    ["letters where PAN digits go", "27AAPFUABCDF1ZV"],
    ["empty", ""],
  ])("refuses %s as FORMAT", (_name, value) => {
    expect(gstinProblem(value)).toBe("FORMAT");
  });

  it("refuses a state code that does not exist, even with a correct check character", () => {
    expect(gstinProblem(withCheck("00AAPFU0939F1Z"))).toBe("UNKNOWN_STATE");
    expect(gstinProblem(withCheck("99AAPFU0939F1Z"))).toBe("UNKNOWN_STATE");
    expect(gstinProblem(withCheck("29AAPFU0939F1Z"))).toBeNull();
  });

  it("normalises what people type (spaces, lower case)", () => {
    expect(normaliseGstin(" 27aapfu0939f1zv ")).toBe(SAMPLE);
    expect(normaliseGstin("27 AAPFU 0939 F1ZV")).toBe(SAMPLE);
  });
});

describe("GST states and registration", () => {
  it("lists 37 places, every code two digits, without the retired or central codes", () => {
    expect(GST_STATES.size).toBe(37);
    for (const code of GST_STATES.keys()) expect(code).toMatch(/^[0-9]{2}$/);
    for (const retired of ["25", "28", "99"]) expect(GST_STATES.has(retired)).toBe(false);
    expect(GST_STATES.get("33")).toBe("Tamil Nadu");
    expect(GST_STATES.get("37")).toBe("Andhra Pradesh");
  });

  it("registered and composition businesses need a GSTIN; unregistered ones do not", () => {
    expect(needsGstin("registered")).toBe(true);
    expect(needsGstin("composition")).toBe(true);
    expect(needsGstin("unregistered")).toBe(false);
  });
});
