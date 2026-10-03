import { afterAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import type { TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext } from "@/modules/auth";
import { createProduct, getCatalogLists } from "@/modules/catalog";
import { changeShopType, getBusinessProfile, SettingsError, updateBusinessProfile } from "@/modules/tenants";
import { registerVerifiedUser } from "../helpers/auth";

// Shop type may change only until the first product exists (business rules
// 11); "prices include GST" locks at the same moment (open question 28).

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

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof SettingsError) return error.code;
    throw error;
  }
}

const profileInput = (p: Awaited<ReturnType<typeof getBusinessProfile>>, overrides: Record<string, unknown> = {}) => ({
  businessName: p.businessName,
  addressLine1: p.addressLine1 ?? "",
  addressLine2: p.addressLine2 ?? "",
  city: p.city ?? "",
  stateCode: p.stateCode ?? "",
  pincode: p.pincode ?? "",
  phone: p.phone ?? "",
  contactEmail: p.contactEmail ?? "",
  gstRegistration: "unregistered",
  gstin: "",
  pricesIncludeTax: p.pricesIncludeTax,
  invoicePrefix: p.invoicePrefix,
  creditNotePrefix: p.creditNotePrefix,
  version: p.version,
  ...overrides,
});

describe("shop type", () => {
  it("can switch while there are no products; then both are locked", async () => {
    const ctx = await newShop("Switch");
    let profile = await getBusinessProfile(ctx);
    expect(await changeShopType(ctx, { template: "mobile", version: profile.version })).toEqual({ changed: true, version: profile.version + 1 });
    profile = await getBusinessProfile(ctx);
    expect(profile.template).toBe("mobile");
    // An old settings page cannot overwrite after the switch.
    expect(await codeOf(changeShopType(ctx, { template: "clothing", version: profile.version - 1 }))).toBe("CHANGED_BY_SOMEONE_ELSE");
    expect(await codeOf(changeShopType(ctx, { template: "clothing", version: profile.version }))).toBe("ok");
    profile = await getBusinessProfile(ctx);

    const unitId = (await getCatalogLists(ctx)).units.find((u) => u.code === "pcs")?.id ?? "";
    await createProduct(ctx, { name: "First", unitId, taxCategory: "test_5", variants: [{ sku: "F-1", sellingPricePaise: 100 }] });
    expect(await codeOf(changeShopType(ctx, { template: "mobile", version: profile.version }))).toBe("LOCKED_BY_PRODUCTS");
    expect(await codeOf(updateBusinessProfile(ctx, profileInput(profile, { pricesIncludeTax: !profile.pricesIncludeTax })))).toBe("LOCKED_BY_PRODUCTS");
    // Other settings still save.
    expect(await codeOf(updateBusinessProfile(ctx, profileInput(profile, { city: "Chennai" })))).toBe("ok");
  });
});
