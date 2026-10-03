import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import { readProductRows, type Lookups } from "./csv-import";

const lookups: Lookups = {
  template: "clothing",
  categories: new Map([["shirts", "cat-1"]]),
  brands: new Map([["raymond", "brand-1"]]),
  units: new Map([["pcs", "unit-1"]]),
  taxCategories: new Map([["test_5", "test_5"], ["test 5%", "test_5"]]),
};
const HEADER = "product_name,category,brand,unit,tax,hsn,sku,size,colour,selling_price,mrp,cost,barcode";

describe("readProductRows", () => {
  it("groups lines of the same product into variants, prices in paise", () => {
    const { products, errors, hasCost } = readProductRows(
      parseCsv(`${HEADER}\nShirt,Shirts,Raymond,pcs,TEST 5%,6205,SH-M,M,Blue,799.50,999,450,890111\nShirt,,,,,,SH-L,L,Blue,849,,,\nJeans,,,pcs,test_5,,JN-1,32,,1299,,,`),
      lookups,
    );
    expect(errors).toEqual([]);
    expect(hasCost).toBe(true);
    expect(products.map((p) => ({ name: p.name, cat: p.categoryId, tax: p.taxCategory, skus: p.variants.map((v) => [v.sku, v.sellingPricePaise, v.attributes]) }))).toEqual([
      { name: "Shirt", cat: "cat-1", tax: "test_5", skus: [["SH-M", 79_950, { size: "M", colour: "Blue" }], ["SH-L", 84_900, { size: "L", colour: "Blue" }]] },
      { name: "Jeans", cat: null, tax: "test_5", skus: [["JN-1", 129_900, { size: "32" }]] },
    ]);
    expect(products[0]?.variants[0]?.barcode).toBe("890111");
  });

  it("reports every problem with its line and column", () => {
    const { errors } = readProductRows(
      parseCsv(`${HEADER}\nShirt,Nope,Raymond,kg,GST 99,,SH-1,M,,12.345,,,\nShirt,,,,,,sh-1,L,,10,,,\n,,,pcs,test_5,,X1,,,abc,,,`),
      lookups,
    );
    expect(errors).toEqual([
      { row: 2, column: "selling_price", message: '"12.345" is not an amount in rupees (e.g. 799 or 799.50).' },
      { row: 2, column: "category", message: 'No active category "Nope". Add it under Catalog lists first.' },
      { row: 2, column: "unit", message: 'No active unit with code "kg".' },
      { row: 2, column: "tax", message: 'No tax rate "GST 99".' },
      { row: 3, column: "sku", message: "The same SKU is on line 2." },
      { row: 4, column: "product_name", message: "Enter the product name." },
      { row: 4, column: "selling_price", message: '"abc" is not an amount in rupees (e.g. 799 or 799.50).' },
    ]);
  });

  it("refuses unknown or missing columns, empty files, too many rows", () => {
    expect(readProductRows(parseCsv("product_name,price\nx,1"), lookups).errors.map((e) => e.message)).toEqual([
      'Unknown column "price".',
      'Missing column "unit".',
      'Missing column "tax".',
      'Missing column "sku".',
      'Missing column "selling_price".',
    ]);
    expect(readProductRows([], lookups).errors[0]?.message).toBe("The file is empty.");
    const many = [HEADER, ...Array.from({ length: 2001 }, (_, i) => `P${String(i)},,,pcs,test_5,,S${String(i)},,,1,,,`)].join("\n");
    expect(readProductRows(parseCsv(many), lookups).errors[0]?.message).toBe("At most 2000 rows per file.");
  });

  it("product-level columns must agree across a product's lines", () => {
    const { errors } = readProductRows(parseCsv(`${HEADER}\nShirt,,,pcs,test_5,,A,M,,1,,,\nShirt,,,pcs,test_18,,B,L,,1,,,`), {
      ...lookups,
      taxCategories: new Map([...lookups.taxCategories, ["test_18", "test_18"]]),
    });
    expect(errors).toEqual([{ row: 3, column: "tax", message: "Differs from line 2 of the same product." }]);
  });
});
