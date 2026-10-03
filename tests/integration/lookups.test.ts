import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { memberships, roles } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { addBarcode, createProduct, describeVariants, findVariantsByCode, getCatalogLists, setVariantArchived } from "@/modules/catalog";
import { closeBranch, createBranch, listBranchChoices } from "@/modules/tenants";
import { registerVerifiedUser } from "../helpers/auth";

// Item lookups by SKU or barcode, item names by id, and branch choices for
// the stock and purchase screens: who may use them, and other businesses.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function newShop(label: string, template: "clothing" | "mobile" = "clothing"): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template });
  const r = await getRequestContext(owner.headers);
  if (r.kind !== "member") throw new Error("expected a member");
  return r.ctx;
}

async function memberWithRole(owner: TenantContext, role: string): Promise<TenantContext> {
  const user = await registerVerifiedUser(`Lookup ${role}`);
  await withTenant(owner, async (tx) => {
    const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
    await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
  });
  const result = await getRequestContext(user.headers);
  if (result.kind !== "member") throw new Error("member");
  return result.ctx;
}

async function shirt(ctx: TenantContext, sku: string) {
  const lists = await getCatalogLists(ctx);
  const product = await createProduct(ctx, {
    name: "Cotton Shirt",
    unitId: lists.units.find((u) => u.code === "pcs")?.id ?? "",
    taxCategory: "test_5",
    variants: [
      { sku, attributes: { size: "M", colour: "Blue" }, sellingPricePaise: 79_900 },
      { sku: `${sku}-L`, attributes: { size: "L" }, sellingPricePaise: 84_900 },
    ],
  });
  return product;
}

describe("finding items by SKU or barcode", () => {
  it("SKU ignores case, barcode is exact; unknown codes are left out; names include the variant", async () => {
    const ctx = await newShop("Lookup find");
    const product = await shirt(ctx, "SH-M");
    const m = product.variants.find((v) => v.sku === "SH-M");
    await addBarcode(ctx, { variantId: m?.id, code: "8901234500011" });
    const found = await findVariantsByCode(ctx, { codes: ["sh-m", "8901234500011", "NOPE", "SH-M-L"] });
    expect(found.get("sh-m")).toEqual({
      variantId: m?.id,
      productId: product.id,
      name: "Cotton Shirt · M / Blue",
      sku: "SH-M",
      trackSerial: false,
      unitCode: "pcs",
      allowsFraction: false,
      active: true,
    });
    expect(found.get("8901234500011")?.variantId).toBe(m?.id);
    expect(found.get("SH-M-L")?.name).toBe("Cotton Shirt · L");
    expect(found.has("NOPE")).toBe(false);
    expect(await findVariantsByCode(ctx, { codes: [] })).toEqual(new Map());
    await expect(findVariantsByCode(ctx, { codes: ["bad code!"] })).rejects.toThrow();
  });

  it("describes items by id, archived ones included", async () => {
    const ctx = await newShop("Lookup describe");
    const product = await shirt(ctx, "DS-1");
    const l = product.variants.find((v) => v.sku === "DS-1-L");
    await setVariantArchived(ctx, { id: l?.id, archived: true });
    const described = await describeVariants(ctx, { variantIds: product.variants.map((v) => v.id) });
    expect(described.size).toBe(2);
    expect(described.get(l?.id ?? "")).toMatchObject({ name: "Cotton Shirt · L", active: false });
  });

  it("a cashier and an accountant may look items up; another business sees nothing", async () => {
    const owner = await newShop("Lookup roles");
    const product = await shirt(owner, "RL-1");
    expect((await findVariantsByCode(await memberWithRole(owner, "Cashier"), { codes: ["RL-1"] })).size).toBe(1);
    expect((await findVariantsByCode(await memberWithRole(owner, "Accountant"), { codes: ["RL-1"] })).size).toBe(1);
    const other = await newShop("Lookup other");
    await shirt(other, "OT-1");
    expect((await findVariantsByCode(other, { codes: ["RL-1"] })).size).toBe(0);
    expect((await describeVariants(other, { variantIds: product.variants.map((v) => v.id) })).size).toBe(0);
  });
});

describe("branch choices", () => {
  it("a manager and a cashier see the branches (open and closed) but cannot manage them", async () => {
    const owner = await newShop("Lookup branches");
    const { id } = await createBranch(owner, { name: "Second" });
    await closeBranch(owner, { branchId: id });
    for (const role of ["Manager", "Cashier", "Accountant"]) {
      const member = await memberWithRole(owner, role);
      const choices = await listBranchChoices(member);
      expect(choices.map((b) => [b.name, b.open]).sort()).toEqual([["Main branch", true], ["Second", false]].sort());
      await expect(createBranch(member, { name: `By ${role} ${randomUUID().slice(0, 4)}` })).rejects.toBeInstanceOf(PermissionDeniedError);
    }
  });
});
