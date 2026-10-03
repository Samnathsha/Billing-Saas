import { describe, expect, it } from "vitest";
import { attributesSchema, variantKey, variantLabel } from "./templates";

describe("clothing", () => {
  it("variants take size, colour and fabric; blanks dropped, text trimmed", () => {
    expect(attributesSchema("clothing", "variant").parse({ size: " M ", colour: "Blue", fabric: "" })).toEqual({ size: "M", colour: "Blue" });
  });

  it("refuses fields of another template or unknown fields", () => {
    expect(() => attributesSchema("clothing", "variant").parse({ storage: "128 GB" })).toThrow();
    expect(() => attributesSchema("clothing", "variant").parse({ size: "M", price: 1 })).toThrow();
    expect(() => attributesSchema("clothing", "product").parse({ model: "X" })).toThrow();
  });

  it("refuses over-long values and non-text", () => {
    expect(() => attributesSchema("clothing", "variant").parse({ size: "x".repeat(21) })).toThrow();
    expect(() => attributesSchema("clothing", "variant").parse({ size: 42 })).toThrow();
  });
});

describe("mobile", () => {
  it("products need a model; variants take RAM, storage, colour", () => {
    expect(attributesSchema("mobile", "product").parse({ model: " Galaxy A15 " })).toEqual({ model: "Galaxy A15" });
    expect(() => attributesSchema("mobile", "product").parse({})).toThrow();
    expect(() => attributesSchema("mobile", "product").parse({ model: "  " })).toThrow();
    expect(attributesSchema("mobile", "variant").parse({ ram: "6 GB", storage: "128 GB", colour: "Black" })).toEqual({
      ram: "6 GB",
      storage: "128 GB",
      colour: "Black",
    });
    expect(() => attributesSchema("mobile", "variant").parse({ size: "M" })).toThrow();
  });
});

describe("variant identity", () => {
  it("the same fields in another order or case are the same variant", () => {
    expect(variantKey({ size: "M", colour: "Blue" })).toBe(variantKey({ colour: "blue", size: "m" }));
    expect(variantKey({ size: "M" })).not.toBe(variantKey({ size: "L" }));
    expect(variantKey({})).toBe(variantKey({}));
  });

  it("labels join the values", () => {
    expect(variantLabel({ size: "M", colour: "Blue" })).toBe("M / Blue");
    expect(variantLabel({})).toBe("");
  });
});
