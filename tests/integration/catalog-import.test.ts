import { afterAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { eq } from "drizzle-orm";
import { memberships, roles } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { createProduct, findByBarcode, getCatalogLists, ImportError, importProductsCsv, listProducts } from "@/modules/catalog";
import { registerVerifiedUser } from "../helpers/auth";

// CSV import: all or nothing; a 500-row file; every problem reported.

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

const HEADER = "product_name,unit,tax,sku,size,selling_price,mrp,cost,barcode";

// 100 products x 5 sizes = 500 lines.
function file500(prefix: string, badLine?: number): string {
  const sizes = ["S", "M", "L", "XL", "XXL"];
  const lines = [HEADER];
  for (let p = 0; p < 100; p++) {
    for (const [i, size] of sizes.entries()) {
      lines.push(`Shirt ${String(p)},pcs,TEST 5%,${prefix}-${String(p)}-${size},${size},${String(500 + i)}.50,999,300,${prefix}${String(p * 10 + i).padStart(6, "0")}`);
    }
  }
  if (badLine !== undefined) lines[badLine - 1] = `Broken,pcs,TEST 5%,${prefix}-BAD,M,12.345,,,`;
  return lines.join("\n");
}

describe("importing products from CSV", () => {
  it("a 500-line file creates 100 products with 500 variants, prices in paise, barcodes scannable", async () => {
    const ctx = await newShop("Import 500");
    expect(await importProductsCsv(ctx, { csv: file500("IMP") })).toEqual({ products: 100, variants: 500 });
    const page = await listProducts(ctx, { q: "Shirt 42" });
    expect(page.products[0]?.variants.map((v) => v.sellingPricePaise)).toEqual([50_050, 50_150, 50_250, 50_350, 50_450]);
    expect((await listProducts(ctx, {})).total).toBe(100);
    expect(await findByBarcode(ctx, { code: "IMP000421" })).not.toBeNull();
  }, 120_000);

  it("one bad line out of 500: nothing is imported and the line is reported", async () => {
    const ctx = await newShop("Import Bad");
    const error: unknown = await importProductsCsv(ctx, { csv: file500("BAD", 499) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportError);
    expect((error as ImportError).errors).toEqual([
      { row: 499, column: "selling_price", message: '"12.345" is not an amount in rupees (e.g. 799 or 799.50).' },
    ]);
    expect((await listProducts(ctx, {})).total).toBe(0);
  }, 120_000);

  it("SKUs and barcodes already in use are reported, and nothing is imported", async () => {
    const ctx = await newShop("Import Clash");
    const unitId = (await getCatalogLists(ctx)).units.find((u) => u.code === "pcs")?.id ?? "";
    await createProduct(ctx, { name: "Existing", unitId, taxCategory: "test_5", variants: [{ sku: "OLD-1", sellingPricePaise: 100 }] });
    const csv = `${HEADER}\nNew,pcs,test_5,old-1,M,10,,,\nNew,pcs,test_5,NEW-2,L,10,5,,`;
    const error = (await importProductsCsv(ctx, { csv }).catch((e: unknown) => e)) as ImportError;
    expect(error.errors).toEqual([
      { row: 2, column: "sku", message: "This SKU is already used by another item." },
      { row: 3, column: "mrpPaise", message: "The selling price cannot be above the MRP." },
    ]);
    expect((await listProducts(ctx, {})).total).toBe(1);
  });

  it("a cashier cannot import", async () => {
    const owner = await newShop("Import Cashier");
    const cashier = await registerVerifiedUser("Import Cashier");
    await withTenant(owner, async (tx) => {
      const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, "Cashier"));
      await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: cashier.userId, roleId: r?.id ?? "" });
    });
    const ctx = await getRequestContext(cashier.headers);
    if (ctx.kind !== "member") throw new Error("expected a member");
    await expect(importProductsCsv(ctx.ctx, { csv: `${HEADER}\nA,pcs,test_5,A1,M,10,,,` })).rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await listProducts(owner, {})).total).toBe(0);
  });
});
