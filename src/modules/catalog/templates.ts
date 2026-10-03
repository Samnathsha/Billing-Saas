import { z } from "zod";

// Template fields (blueprint 6.4). Stored as JSON, but each template has a
// strict schema per level; unknown fields are refused. Blank values are
// dropped, text is trimmed.
// - Clothing: size, colour, fabric per variant (brand is the brand list).
// - Mobile: model per product; RAM, storage, colour per variant; warranty
//   months on the product.

export type Template = "clothing" | "mobile";
export type Level = "product" | "variant";

const text = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? undefined : v.trim()) : v),
    z.string().max(max, { error: `Use at most ${String(max)} characters.` }).optional(),
  );

const SCHEMAS = {
  clothing: {
    product: z.strictObject({}),
    variant: z.strictObject({ size: text(20), colour: text(30), fabric: text(50) }),
  },
  mobile: {
    product: z.strictObject({
      model: z.preprocess(
        (v) => (typeof v === "string" ? v.trim() : v),
        z.string().min(1, { error: "Enter the model." }).max(100, { error: "Use at most 100 characters." }),
      ),
    }),
    variant: z.strictObject({ ram: text(20), storage: text(20), colour: text(30) }),
  },
} as const;

export type Attributes = Record<string, string>;

export function attributesSchema(template: Template, level: Level): z.ZodType<Attributes> {
  return SCHEMAS[template][level].transform((value) => {
    // Drop empty optional fields so equal variants compare equal.
    const out: Attributes = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === "string") out[key] = v;
    return out;
  });
}

// Two variants of one product with the same fields (ignoring case and
// order) would be indistinguishable on a bill.
export function variantKey(attributes: Attributes): string {
  return JSON.stringify(
    Object.keys(attributes)
      .sort()
      .map((k) => [k, (attributes[k] ?? "").toLowerCase()]),
  );
}

// The order fields are shown in (the database stores JSON keys in its own
// order).
const FIELD_ORDER: Record<Template, Record<Level, readonly string[]>> = {
  clothing: { product: [], variant: ["size", "colour", "fabric"] },
  mobile: { product: ["model"], variant: ["ram", "storage", "colour"] },
};

// Keeps only text fields, in the template's order (unknown ones last).
export function orderedAttributes(template: Template, level: Level, value: unknown): Attributes {
  if (value === null || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const order = FIELD_ORDER[template][level];
  const keys = [...order.filter((k) => k in source), ...Object.keys(source).filter((k) => !order.includes(k)).sort()];
  const out: Attributes = {};
  for (const key of keys) {
    const v = source[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

// What a variant is called on screens and bills, e.g. "M / Blue".
export function variantLabel(attributes: Attributes): string {
  return Object.values(attributes).join(" / ");
}
