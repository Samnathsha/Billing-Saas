import { asc, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auditLogs, memberships, productVariants, roles } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import {
  addVariant,
  changeVariantPrice,
  createBrand,
  createCategory,
  createProduct,
  getCatalogLists,
  getProduct,
  listProducts,
  ProductError,
  setListItemArchived,
  setProductArchived,
  setVariantArchived,
  updateProduct,
  updateVariant,
} from "@/modules/catalog";
import { registerVerifiedUser } from "../helpers/auth";

// Products and variants: prices in paise, the price and cost rules, cost
// hidden from those without "View cost price", template fields, audit,
// permissions, other businesses.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function memberCtx(headers: Headers): Promise<TenantContext> {
  const result = await getRequestContext(headers);
  if (result.kind !== "member") throw new Error(`expected a member, got ${result.kind}`);
  return result.ctx;
}

async function newShop(label: string, template: "clothing" | "mobile" = "clothing"): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template });
  return memberCtx(owner.headers);
}

async function staff(owner: TenantContext, role: string): Promise<TenantContext> {
  const user = await registerVerifiedUser(`Products ${role}`);
  await withTenant(owner, async (tx) => {
    const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
    await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
  });
  return memberCtx(user.headers);
}

async function unitId(ctx: TenantContext, code: string): Promise<string> {
  return (await getCatalogLists(ctx)).units.find((u) => u.code === code)?.id ?? "";
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof ProductError || error instanceof PermissionDeniedError) return error.code;
    if (error instanceof ZodError) return `INVALID:${error.issues[0]?.path.join(".") ?? ""}`;
    throw error;
  }
}

async function shirt(ctx: TenantContext, overrides: Record<string, unknown> = {}) {
  return {
    name: "Cotton Shirt",
    unitId: await unitId(ctx, "pcs"),
    taxCategory: "test_5",
    hsnCode: "6205",
    variants: [
      { sku: `SH-M-${ctx.tenantId.slice(0, 6)}`, attributes: { size: "M", colour: "Blue" }, sellingPricePaise: 79_900, mrpPaise: 99_900, costPricePaise: 45_000 },
      { sku: `SH-L-${ctx.tenantId.slice(0, 6)}`, attributes: { size: "L", colour: "Blue" }, sellingPricePaise: 84_900, costPricePaise: 47_500, reorderLevel: "5" },
    ],
    ...overrides,
  };
}

async function auditActions(ctx: TenantContext): Promise<{ action: string; before: unknown; after: unknown }[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({ action: auditLogs.action, before: auditLogs.before, after: auditLogs.after })
      .from(auditLogs)
      .where(sql`${auditLogs.action} LIKE 'product.%'`)
      .orderBy(asc(auditLogs.occurredAt), asc(auditLogs.id)),
  );
}

describe("creating a product", () => {
  it("a clothing product with two variants, prices in paise, audited", async () => {
    const ctx = await newShop("Create");
    const product = await createProduct(ctx, await shirt(ctx));
    expect(product).toMatchObject({ name: "Cotton Shirt", hsnCode: "6205", taxCategory: "test_5", trackSerial: false, active: true });
    expect(product.variants.map((v) => ({ label: v.label, price: v.sellingPricePaise, mrp: v.mrpPaise, cost: v.costPricePaise, reorder: v.reorderLevel }))).toEqual([
      { label: "M / Blue", price: 79_900, mrp: 99_900, cost: 45_000, reorder: "0.000" },
      { label: "L / Blue", price: 84_900, mrp: null, cost: 47_500, reorder: "5.000" },
    ]);
    expect((await auditActions(ctx)).map((a) => a.action)).toEqual(["product.created"]);
  });

  it.each([
    ["a price of 0", { variants: [{ sku: "Z0", sellingPricePaise: 0 }] }, "INVALID:variants.0.sellingPricePaise"],
    ["a price in rupees with decimals", { variants: [{ sku: "Z1", sellingPricePaise: 799.5 }] }, "INVALID:variants.0.sellingPricePaise"],
    ["a selling price above the MRP", { variants: [{ sku: "Z2", sellingPricePaise: 1000, mrpPaise: 999 }] }, "INVALID:variants.0.mrpPaise"],
    ["a negative cost", { variants: [{ sku: "Z3", sellingPricePaise: 1000, costPricePaise: -1 }] }, "INVALID:variants.0.costPricePaise"],
    ["no variants", { variants: [] }, "INVALID:variants"],
    ["a bad HSN code", { hsnCode: "62051" }, "INVALID:hsnCode"],
    ["a bad SKU", { variants: [{ sku: "has space", sellingPricePaise: 1000 }] }, "INVALID:variants.0.sku"],
    ["mobile fields in a clothing shop", { variants: [{ sku: "Z4", sellingPricePaise: 1000, attributes: { storage: "64 GB" } }] }, "INVALID:variants.0"],
    ["an extra field", { tenantId: "00000000-0000-4000-8000-000000000000" }, "INVALID:"],
  ])("refuses %s", async (_name, overrides, expected) => {
    const ctx = await newShop("Refuse");
    expect(await codeOf(createProduct(ctx, await shirt(ctx, overrides)))).toBe(expected);
    expect((await listProducts(ctx, {})).total).toBe(0);
  });

  it("refuses two identical variants, a repeated SKU, an unknown tax rate", async () => {
    const ctx = await newShop("Dupes");
    const same = { attributes: { size: "M", colour: "Blue" }, sellingPricePaise: 1000 };
    expect(await codeOf(createProduct(ctx, await shirt(ctx, { variants: [{ sku: "A1", ...same }, { sku: "A2", attributes: { colour: "blue", size: "m" }, sellingPricePaise: 1000 }] })))).toBe("DUPLICATE_VARIANT");
    expect(await codeOf(createProduct(ctx, await shirt(ctx, { variants: [{ sku: "B1", sellingPricePaise: 1000 }, { sku: "b1", attributes: { size: "L" }, sellingPricePaise: 1000 }] })))).toBe("SKU_TAKEN");
    expect(await codeOf(createProduct(ctx, await shirt(ctx, { taxCategory: "made_up" })))).toBe("TAX_CATEGORY_UNKNOWN");
    await createProduct(ctx, await shirt(ctx));
    expect(await codeOf(createProduct(ctx, await shirt(ctx, { name: "Other" })))).toBe("SKU_TAKEN");
  });

  it("refuses an archived category or brand; serial tracking needs a whole unit", async () => {
    const ctx = await newShop("Refs");
    const cat = await createCategory(ctx, { name: "Old", parentId: null });
    await setListItemArchived(ctx, { kind: "category", id: cat.id, archived: true });
    expect(await codeOf(createProduct(ctx, await shirt(ctx, { categoryId: cat.id })))).toBe("LIST_ITEM_INVALID");
    const brand = await createBrand(ctx, { name: "Gone" });
    await setListItemArchived(ctx, { kind: "brand", id: brand.id, archived: true });
    expect(await codeOf(createProduct(ctx, await shirt(ctx, { brandId: brand.id })))).toBe("LIST_ITEM_INVALID");
    expect(await codeOf(createProduct(ctx, await shirt(ctx, { trackSerial: true, unitId: await unitId(ctx, "m") })))).toBe("SERIAL_NEEDS_WHOLE_UNIT");
  });

  it("a mobile shop: model required, RAM/storage/colour per variant, IMEI tracking", async () => {
    const ctx = await newShop("Mobile", "mobile");
    const phone = {
      name: "Galaxy A15",
      unitId: await unitId(ctx, "pcs"),
      taxCategory: "test_18",
      trackSerial: true,
      warrantyMonths: 12,
      attributes: { model: "SM-A155" },
      variants: [{ sku: "A15-6-128", attributes: { ram: "6 GB", storage: "128 GB", colour: "Black" }, sellingPricePaise: 1_499_900 }],
    };
    expect(await codeOf(createProduct(ctx, { ...phone, attributes: {} }))).toBe("INVALID:attributes.model");
    expect(await codeOf(createProduct(ctx, { ...phone, variants: [{ sku: "X", attributes: { size: "M" }, sellingPricePaise: 1000 }] }))).toBe("INVALID:variants.0");
    const created = await createProduct(ctx, phone);
    expect(created).toMatchObject({ trackSerial: true, warrantyMonths: 12, attributes: { model: "SM-A155" } });
    expect(created.variants[0]?.label).toBe("6 GB / 128 GB / Black");
  });
});

describe("cost price is only for 'View cost price and profit'", () => {
  it("a cashier can look products up but never receives the cost, and cannot create", async () => {
    const owner = await newShop("Cost Cashier");
    const product = await createProduct(owner, await shirt(owner));
    const cashier = await staff(owner, "Cashier");
    const seen = await getProduct(cashier, product.id);
    for (const v of seen.variants) expect(v).not.toHaveProperty("costPricePaise");
    expect(JSON.stringify(await listProducts(cashier, {}))).not.toContain("costPricePaise");
    expect(JSON.stringify(seen)).not.toContain("45000");
    expect(await codeOf(createProduct(cashier, await shirt(owner, { name: "Sneaky" })))).toBe("FORBIDDEN");
  });

  it("an accountant sees the cost but cannot create or change prices", async () => {
    const owner = await newShop("Cost Accountant");
    const product = await createProduct(owner, await shirt(owner));
    const accountant = await staff(owner, "Accountant");
    expect((await getProduct(accountant, product.id)).variants[0]?.costPricePaise).toBe(45_000);
    expect(await codeOf(createProduct(accountant, await shirt(owner, { name: "No" })))).toBe("FORBIDDEN");
    const v = product.variants[0];
    expect(await codeOf(changeVariantPrice(accountant, { variantId: v?.id, version: v?.version, sellingPricePaise: 1, mrpPaise: null }))).toBe("FORBIDDEN");
  });

  it("a manager may create products and change prices", async () => {
    const owner = await newShop("Manager Products");
    const manager = await staff(owner, "Manager");
    expect(await codeOf(createProduct(manager, await shirt(owner)))).toBe("ok");
  });
});

describe("changing prices", () => {
  it("is audited with old and new values; the same values change nothing; an old page is refused", async () => {
    const ctx = await newShop("Price");
    const product = await createProduct(ctx, await shirt(ctx));
    const v = product.variants[0];
    if (v === undefined) throw new Error("no variant");
    expect(await changeVariantPrice(ctx, { variantId: v.id, version: v.version, sellingPricePaise: 74_900, mrpPaise: 99_900 })).toEqual({ version: v.version + 1 });
    expect(await changeVariantPrice(ctx, { variantId: v.id, version: v.version + 1, sellingPricePaise: 74_900, mrpPaise: 99_900 })).toEqual({ version: v.version + 1 });
    expect(await codeOf(changeVariantPrice(ctx, { variantId: v.id, version: v.version, sellingPricePaise: 1_000, mrpPaise: null }))).toBe("CHANGED_BY_SOMEONE_ELSE");
    expect(await codeOf(changeVariantPrice(ctx, { variantId: v.id, version: v.version + 1, sellingPricePaise: 100_000, mrpPaise: 99_900 }))).toBe("INVALID:mrpPaise");
    const priceChanges = (await auditActions(ctx)).filter((a) => a.action === "product.price_changed");
    expect(priceChanges).toEqual([{ action: "product.price_changed", before: { sellingPricePaise: 79_900 }, after: { sellingPricePaise: 74_900 } }]);
  });

  it("the cost can be changed too, and is audited", async () => {
    const ctx = await newShop("Cost Change");
    const v = (await createProduct(ctx, await shirt(ctx))).variants[1];
    if (v === undefined) throw new Error("no variant");
    await changeVariantPrice(ctx, { variantId: v.id, version: v.version, sellingPricePaise: v.sellingPricePaise, mrpPaise: null, costPricePaise: 50_000 });
    expect((await auditActions(ctx)).at(-1)).toEqual({ action: "product.price_changed", before: { costPricePaise: 47_500 }, after: { costPricePaise: 50_000 } });
  });
});

describe("editing", () => {
  it("product details: only changed fields audited; an old page is refused", async () => {
    const ctx = await newShop("Edit");
    const p = await createProduct(ctx, await shirt(ctx));
    const result = await updateProduct(ctx, { productId: p.id, version: p.version, name: "Linen Shirt", taxCategory: "test_5", hsnCode: "6205" });
    expect(result).toEqual({ version: p.version + 1 });
    expect((await auditActions(ctx)).at(-1)).toEqual({ action: "product.updated", before: { name: "Cotton Shirt" }, after: { name: "Linen Shirt" } });
    expect(await codeOf(updateProduct(ctx, { productId: p.id, version: p.version, name: "X", taxCategory: "test_5" }))).toBe("CHANGED_BY_SOMEONE_ELSE");
  });

  it("variants: add, change SKU and details; duplicates refused", async () => {
    const ctx = await newShop("Variants");
    const p = await createProduct(ctx, await shirt(ctx));
    expect(await codeOf(addVariant(ctx, { productId: p.id, variant: { sku: "NEW-1", attributes: { size: "M", colour: "blue" }, sellingPricePaise: 1000 } }))).toBe("DUPLICATE_VARIANT");
    expect(await codeOf(addVariant(ctx, { productId: p.id, variant: { sku: "NEW-1", attributes: { size: "XL", colour: "Blue" }, sellingPricePaise: 89_900 } }))).toBe("ok");
    const v = p.variants[0];
    if (v === undefined) throw new Error("no variant");
    expect(await codeOf(updateVariant(ctx, { variantId: v.id, version: v.version, sku: "new-1", attributes: v.attributes, reorderLevel: "0" }))).toBe("SKU_TAKEN");
    expect(await codeOf(updateVariant(ctx, { variantId: v.id, version: v.version, sku: "SH-MED", attributes: { size: "L", colour: "Blue" }, reorderLevel: "2" }))).toBe("DUPLICATE_VARIANT");
    expect(await codeOf(updateVariant(ctx, { variantId: v.id, version: v.version, sku: "SH-MED", attributes: { size: "S", colour: "Blue" }, reorderLevel: "2.5" }))).toBe("ok");
    const after = await getProduct(ctx, p.id);
    expect(after.variants.map((x) => x.sku)).toEqual(["SH-MED", p.variants[1]?.sku, "NEW-1"]);
  });

  it("archive: the last active variant is kept; products archive and restore", async () => {
    const ctx = await newShop("Archive Products");
    const p = await createProduct(ctx, await shirt(ctx));
    const [a, b] = p.variants;
    if (a === undefined || b === undefined) throw new Error("no variants");
    await setVariantArchived(ctx, { id: a.id, archived: true });
    expect(await codeOf(setVariantArchived(ctx, { id: b.id, archived: true }))).toBe("LAST_ACTIVE_VARIANT");
    await setProductArchived(ctx, { id: p.id, archived: true });
    expect((await getProduct(ctx, p.id)).active).toBe(false);
    await setProductArchived(ctx, { id: p.id, archived: false });
    expect(await codeOf(setProductArchived(ctx, { id: p.id, archived: false }))).toBe("NOT_ARCHIVED");
  });
});

describe("another business", () => {
  it("cannot see, edit or reprice another business's products, or use its lists", async () => {
    const a = await newShop("Prod A");
    const b = await newShop("Prod B");
    const bProduct = await createProduct(b, await shirt(b));
    const bVariant = bProduct.variants[0];
    expect(await codeOf(getProduct(a, bProduct.id))).toBe("NOT_FOUND");
    expect(await codeOf(updateProduct(a, { productId: bProduct.id, version: 1, name: "Hacked", taxCategory: "test_5" }))).toBe("NOT_FOUND");
    expect(await codeOf(changeVariantPrice(a, { variantId: bVariant?.id, version: 1, sellingPricePaise: 1, mrpPaise: null }))).toBe("NOT_FOUND");
    expect(await codeOf(createProduct(a, await shirt(a, { unitId: await unitId(b, "pcs") })))).toBe("LIST_ITEM_INVALID");
    // Same SKU in another business is fine.
    expect(await codeOf(createProduct(a, await shirt(b)))).toBe("LIST_ITEM_INVALID");
    expect(await codeOf(createProduct(a, { ...(await shirt(b)), unitId: await unitId(a, "pcs") }))).toBe("ok");
    expect((await getProduct(b, bProduct.id)).variants[0]?.sellingPricePaise).toBe(79_900);
    // Two businesses and several products: over 30 s on the remote test DB.
  }, 90_000);
});

describe("the database refuses bad values on its own", () => {
  it.each([
    ["a price of 0", { sellingPricePaise: 0 }],
    ["a selling price above the MRP", { mrpPaise: 1 }],
    ["a negative cost", { costPricePaise: -5 }],
    ["a negative reorder level", { reorderLevel: "-1" }],
    ["a SKU with spaces", { sku: "A B" }],
  ])("%s", async (_name, values) => {
    const ctx = await newShop("DB Checks");
    const p = await createProduct(ctx, await shirt(ctx));
    await expect(withTenant(ctx, (tx) => tx.update(productVariants).set(values).where(eq(productVariants.id, p.variants[0]?.id ?? "")))).rejects.toThrow();
  });

  it("the same SKU in other capitals is refused by the database", async () => {
    const ctx = await newShop("DB Sku");
    const p = await createProduct(ctx, await shirt(ctx));
    await expect(
      withTenant(ctx, (tx) =>
        tx.insert(productVariants).values({ tenantId: ctx.tenantId, productId: p.id, sku: (p.variants[0]?.sku ?? "").toLowerCase(), sellingPricePaise: 100 }),
      ),
    ).rejects.toThrow();
  });

  it("nothing can be deleted", async () => {
    const ctx = await newShop("DB Delete");
    await createProduct(ctx, await shirt(ctx));
    const error: unknown = await withTenant(ctx, (tx) => tx.execute("DELETE FROM product_variants")).catch((e: unknown) => e);
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
    expect(cause).toMatch(/permission denied/);
  });
});
