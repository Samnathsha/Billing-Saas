import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import type { TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { addBarcode, createProduct, findByBarcode, getCatalogLists, getProduct, listProducts, ProductError, removeBarcode } from "@/modules/catalog";
import { registerVerifiedUser } from "../helpers/auth";

// Barcodes (a scan finds exactly one item) and search by name, SKU, barcode.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function newShop(label: string): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template: "clothing" });
  const r = await getRequestContext(owner.headers);
  if (r.kind !== "member") throw new Error("expected a member");
  return r.ctx;
}

async function product(ctx: TenantContext, name: string, sku: string) {
  const unitId = (await getCatalogLists(ctx)).units.find((u) => u.code === "pcs")?.id ?? "";
  return createProduct(ctx, { name, unitId, taxCategory: "test_5", variants: [{ sku, sellingPricePaise: 10_000 }] });
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof ProductError || error instanceof PermissionDeniedError) return error.code;
    if (error instanceof ZodError) return "INVALID_INPUT";
    throw error;
  }
}

describe("barcodes", () => {
  it("a scan finds exactly one item; a code cannot be on two items; removing frees it", async () => {
    const ctx = await newShop("Scan");
    const shirt = await product(ctx, "Shirt", "SH-1");
    const pants = await product(ctx, "Pants", "PA-1");
    const shirtVariant = shirt.variants[0]?.id ?? "";
    const { barcodeId } = await addBarcode(ctx, { variantId: shirtVariant, code: "8901234567890" });
    await addBarcode(ctx, { variantId: shirtVariant, code: "SHIRT-ALT" });
    expect(await findByBarcode(ctx, { code: "8901234567890" })).toEqual({ productId: shirt.id, variantId: shirtVariant });
    expect(await findByBarcode(ctx, { code: "0000000000000" })).toBeNull();
    expect(await codeOf(addBarcode(ctx, { variantId: pants.variants[0]?.id, code: "8901234567890" }))).toBe("BARCODE_TAKEN");
    expect((await getProduct(ctx, shirt.id)).variants[0]?.barcodes.map((b) => b.code)).toEqual(["8901234567890", "SHIRT-ALT"]);
    await removeBarcode(ctx, { barcodeId });
    expect(await findByBarcode(ctx, { code: "8901234567890" })).toBeNull();
    expect(await codeOf(addBarcode(ctx, { variantId: pants.variants[0]?.id, code: "8901234567890" }))).toBe("ok");
    expect((await findByBarcode(ctx, { code: "8901234567890" }))?.productId).toBe(pants.id);
  });

  it("refuses odd codes; a cashier can scan but not add", async () => {
    const ctx = await newShop("Scan Rules");
    const shirt = await product(ctx, "Shirt", "SH-2");
    expect(await codeOf(addBarcode(ctx, { variantId: shirt.variants[0]?.id, code: "has space" }))).toBe("INVALID_INPUT");
    expect(await codeOf(addBarcode(ctx, { variantId: shirt.variants[0]?.id, code: "x".repeat(65) }))).toBe("INVALID_INPUT");
  });

  it("another business's code and items are invisible", async () => {
    const a = await newShop("Scan A");
    const b = await newShop("Scan B");
    const bShirt = await product(b, "B Shirt", "SH-B");
    await addBarcode(b, { variantId: bShirt.variants[0]?.id, code: "SHARED-CODE" });
    expect(await findByBarcode(a, { code: "SHARED-CODE" })).toBeNull();
    expect(await codeOf(addBarcode(a, { variantId: bShirt.variants[0]?.id, code: "MINE" }))).toBe("NOT_FOUND");
    // The same code may exist in another business.
    const aShirt = await product(a, "A Shirt", "SH-A");
    expect(await codeOf(addBarcode(a, { variantId: aShirt.variants[0]?.id, code: "SHARED-CODE" }))).toBe("ok");
  });
});

describe("search", () => {
  it("by part of the name (any case), start of SKU, or exact barcode; paged", async () => {
    const ctx = await newShop("Search");
    const linen = await product(ctx, "Linen Shirt", "LN-001");
    await product(ctx, "Cotton Shirt", "CT-001");
    await product(ctx, "Denim Jeans", "DN-001");
    await addBarcode(ctx, { variantId: linen.variants[0]?.id, code: "1112223334445" });
    const names = async (q: string) => (await listProducts(ctx, { q })).products.map((p) => p.name);
    expect(await names("shirt")).toEqual(["Cotton Shirt", "Linen Shirt"]);
    expect(await names("DN-")).toEqual(["Denim Jeans"]);
    expect(await names("1112223334445")).toEqual(["Linen Shirt"]);
    expect(await names("   ")).toEqual(["Cotton Shirt", "Denim Jeans", "Linen Shirt"]);
    expect(await names("nothing like this")).toEqual([]);
    // LIKE wildcards are matched literally, not as "anything".
    expect(await names("%")).toEqual([]);
    expect(await names("_")).toEqual([]);
    expect((await listProducts(ctx, { q: "shirt" })).total).toBe(2);
    // Three products and seven searches: over 30 s on the remote test DB.
  }, 90_000);
});
