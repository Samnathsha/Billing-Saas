import { rupeesToPaise } from "@/lib/money";
import type { Template } from "./templates";

// Turns the rows of a product CSV into product inputs, or row-by-row errors.
// Pure: the lists to look names up in are passed in. One row per variant;
// rows with the same product name form one product. Nothing is created
// here, and categories, brands and units are never created by an import.

export const MAX_ROWS = 2_000;
export const MAX_BYTES = 2 * 1024 * 1024;

export const COLUMNS = [
  "product_name",
  "category",
  "brand",
  "unit",
  "tax",
  "hsn",
  "sku",
  "size",
  "colour",
  "fabric",
  "model",
  "ram",
  "storage",
  "warranty_months",
  "track_imei",
  "selling_price",
  "mrp",
  "cost",
  "reorder_level",
  "barcode",
] as const;
const REQUIRED = ["product_name", "unit", "tax", "sku", "selling_price"] as const;

export interface RowError {
  row: number; // line number in the file (the header is line 1)
  column: string;
  message: string;
}

export interface Lookups {
  template: Template;
  categories: Map<string, string>; // lower-case name -> id (active only)
  brands: Map<string, string>;
  units: Map<string, string>; // lower-case code -> id (active only)
  taxCategories: Map<string, string>; // lower-case code or label -> code
}

export interface ImportedVariant {
  row: number;
  sku: string;
  attributes: Record<string, string>;
  sellingPricePaise: number;
  mrpPaise: number | null;
  costPricePaise: number | null;
  reorderLevel: string;
  barcode: string | null;
}

export interface ImportedProduct {
  row: number;
  name: string;
  categoryId: string | null;
  brandId: string | null;
  unitId: string;
  taxCategory: string;
  hsnCode: string | null;
  attributes: Record<string, string>;
  trackSerial: boolean;
  warrantyMonths: number | null;
  variants: ImportedVariant[];
}

const VARIANT_FIELDS = { clothing: ["size", "colour", "fabric"], mobile: ["ram", "storage", "colour"] } as const;
const PRODUCT_LEVEL = ["category", "brand", "unit", "tax", "hsn", "model", "warranty_months", "track_imei"] as const;

export function readProductRows(
  table: string[][],
  lookups: Lookups,
): { products: ImportedProduct[]; errors: RowError[]; hasCost: boolean } {
  const errors: RowError[] = [];
  const [header, ...rows] = table;
  if (header === undefined) return { products: [], errors: [{ row: 1, column: "", message: "The file is empty." }], hasCost: false };
  const names = header.map((h) => h.trim().toLowerCase());
  const unknown = names.filter((n) => n !== "" && !(COLUMNS as readonly string[]).includes(n));
  for (const n of unknown) errors.push({ row: 1, column: n, message: `Unknown column "${n}".` });
  for (const r of REQUIRED) if (!names.includes(r)) errors.push({ row: 1, column: r, message: `Missing column "${r}".` });
  if (rows.length === 0) errors.push({ row: 2, column: "", message: "There are no product rows." });
  if (rows.length > MAX_ROWS) errors.push({ row: MAX_ROWS + 2, column: "", message: `At most ${String(MAX_ROWS)} rows per file.` });
  if (errors.length > 0) return { products: [], errors, hasCost: false };

  const groups = new Map<string, { product: ImportedProduct; fields: Record<string, string> }>();
  const skus = new Map<string, number>();
  const codes = new Map<string, number>();
  let hasCost = false;

  rows.forEach((cells, index) => {
    const row = index + 2;
    const get = (column: string): string => (cells[names.indexOf(column)] ?? "").trim();
    const fail = (column: string, message: string) => errors.push({ row, column, message });

    const name = get("product_name");
    if (name === "") fail("product_name", "Enter the product name.");
    const sku = get("sku");
    if (sku === "") fail("sku", "Enter the SKU.");
    else {
      const seen = skus.get(sku.toLowerCase());
      if (seen !== undefined) fail("sku", `The same SKU is on line ${String(seen)}.`);
      else skus.set(sku.toLowerCase(), row);
    }
    const money = (column: string, required: boolean): number | null => {
      const raw = get(column);
      if (raw === "") {
        if (required) fail(column, "Enter an amount in rupees.");
        return null;
      }
      const paise = rupeesToPaise(raw);
      if (paise === null) fail(column, `"${raw}" is not an amount in rupees (e.g. 799 or 799.50).`);
      return paise;
    };
    const price = money("selling_price", true);
    const mrp = money("mrp", false);
    const cost = money("cost", false);
    if (cost !== null) hasCost = true;
    const barcode = get("barcode") === "" ? null : get("barcode");
    if (barcode !== null) {
      const seen = codes.get(barcode);
      if (seen !== undefined) fail("barcode", `The same barcode is on line ${String(seen)}.`);
      else codes.set(barcode, row);
    }

    const attributes: Record<string, string> = {};
    for (const f of VARIANT_FIELDS[lookups.template]) if (get(f) !== "") attributes[f] = get(f);
    const variant: ImportedVariant = {
      row,
      sku,
      attributes,
      sellingPricePaise: price ?? -1,
      mrpPaise: mrp,
      costPricePaise: cost,
      reorderLevel: get("reorder_level") === "" ? "0" : get("reorder_level"),
      barcode,
    };

    const key = name.toLowerCase();
    const fields: Record<string, string> = {};
    for (const f of PRODUCT_LEVEL) fields[f] = get(f).toLowerCase();
    const existing = groups.get(key);
    if (existing !== undefined) {
      // Product-level columns must match the product's first line.
      for (const f of PRODUCT_LEVEL) {
        if (fields[f] !== "" && fields[f] !== existing.fields[f]) {
          fail(f, `Differs from line ${String(existing.product.row)} of the same product.`);
        }
      }
      existing.product.variants.push(variant);
      return;
    }

    const lookup = (column: "category" | "brand", map: Map<string, string>): string | null => {
      const value = get(column);
      if (value === "") return null;
      const id = map.get(value.toLowerCase());
      if (id === undefined) fail(column, `No active ${column} "${value}". Add it under Catalog lists first.`);
      return id ?? null;
    };
    const categoryId = lookup("category", lookups.categories);
    const brandId = lookup("brand", lookups.brands);
    const unitId = lookups.units.get(get("unit").toLowerCase());
    if (unitId === undefined) fail("unit", `No active unit with code "${get("unit")}".`);
    const taxCategory = lookups.taxCategories.get(get("tax").toLowerCase());
    if (taxCategory === undefined) fail("tax", `No tax rate "${get("tax")}".`);
    const warranty = get("warranty_months");
    if (warranty !== "" && !/^\d{1,3}$/.test(warranty)) fail("warranty_months", "Use a whole number of months.");
    const track = get("track_imei").toLowerCase();
    if (!["", "yes", "no"].includes(track)) fail("track_imei", 'Use "yes" or "no".');

    groups.set(key, {
      fields,
      product: {
        row,
        name,
        categoryId,
        brandId,
        unitId: unitId ?? "",
        taxCategory: taxCategory ?? "",
        hsnCode: get("hsn") === "" ? null : get("hsn"),
        attributes: lookups.template === "mobile" ? { model: get("model") } : {},
        trackSerial: track === "yes",
        warrantyMonths: warranty === "" ? null : Number(warranty),
        variants: [variant],
      },
    });
  });

  return { products: [...groups.values()].map((g) => g.product), errors, hasCost };
}
