import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { memberships, roles } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { createProduct, getCatalogLists } from "@/modules/catalog";
import { FileError, ImageError, listImages, MAX_IMAGES_PER_PRODUCT, readImage, removeImage, uploadLogo, uploadProductImage } from "@/modules/files";
import { registerVerifiedUser } from "../helpers/auth";

// Logo and product photos: content checks, private reading, permissions,
// other businesses, the per-product limit.

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

async function staff(owner: TenantContext, role: string): Promise<TenantContext> {
  const user = await registerVerifiedUser(`Files ${role}`);
  await withTenant(owner, async (tx) => {
    const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
    await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
  });
  const r = await getRequestContext(user.headers);
  if (r.kind !== "member") throw new Error("expected a member");
  return r.ctx;
}

const png = async () => new Uint8Array(await sharp({ create: { width: 40, height: 20, channels: 3, background: "#c33" } }).png().toBuffer());

async function product(ctx: TenantContext) {
  const unitId = (await getCatalogLists(ctx)).units.find((u) => u.code === "pcs")?.id ?? "";
  return createProduct(ctx, { name: "Photo Shirt", unitId, taxCategory: "test_5", variants: [{ sku: `PH-${ctx.tenantId.slice(0, 6)}`, sellingPricePaise: 100 }] });
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof FileError || error instanceof ImageError || error instanceof PermissionDeniedError) return error.code;
    throw error;
  }
}

describe("logo", () => {
  it("upload, read back as WebP, replace, remove", async () => {
    const ctx = await newShop("Logo");
    const first = await uploadLogo(ctx, { bytes: await png() });
    const read = await readImage(ctx, { fileId: first.fileId });
    expect(read.contentType).toBe("image/webp");
    expect((await sharp(read.bytes).metadata()).format).toBe("webp");
    const second = await uploadLogo(ctx, { bytes: await png() });
    expect((await listImages(ctx, { productId: null })).logoId).toBe(second.fileId);
    expect(await codeOf(readImage(ctx, { fileId: first.fileId }))).toBe("NOT_FOUND");
    await removeImage(ctx, { fileId: second.fileId });
    expect((await listImages(ctx, { productId: null })).logoId).toBeNull();
  });

  it("a renamed .exe or an oversized file is refused, and nothing is stored", async () => {
    const ctx = await newShop("Logo Bad");
    expect(await codeOf(uploadLogo(ctx, { bytes: new Uint8Array(Buffer.concat([Buffer.from("MZ"), Buffer.alloc(500)])) }))).toBe("NOT_AN_IMAGE");
    expect(await codeOf(uploadLogo(ctx, { bytes: new Uint8Array(2 * 1024 * 1024 + 1) }))).toBe("TOO_LARGE");
    expect((await listImages(ctx, { productId: null })).logoId).toBeNull();
  });

  it("only 'Business and tax settings' may change it", async () => {
    const owner = await newShop("Logo Roles");
    const manager = await staff(owner, "Manager");
    expect(await codeOf(uploadLogo(manager, { bytes: await png() }))).toBe("FORBIDDEN");
  });
});

describe("product photos", () => {
  it("added by Manage products, seen by a cashier, at most 8", async () => {
    const owner = await newShop("Photos");
    const p = await product(owner);
    const { fileId } = await uploadProductImage(owner, { productId: p.id, bytes: await png() });
    const cashier = await staff(owner, "Cashier");
    expect((await readImage(cashier, { fileId })).contentType).toBe("image/webp");
    expect(await codeOf(uploadProductImage(cashier, { productId: p.id, bytes: await png() }))).toBe("FORBIDDEN");
    expect(await codeOf(removeImage(cashier, { fileId }))).toBe("FORBIDDEN");
    for (let i = 1; i < MAX_IMAGES_PER_PRODUCT; i++) await uploadProductImage(owner, { productId: p.id, bytes: await png() });
    expect(await codeOf(uploadProductImage(owner, { productId: p.id, bytes: await png() }))).toBe("TOO_MANY_IMAGES");
    expect((await listImages(owner, { productId: p.id })).productImageIds).toHaveLength(MAX_IMAGES_PER_PRODUCT);
  }, 90_000);

  it("another business cannot read, remove or attach photos", async () => {
    const a = await newShop("Photos A");
    const b = await newShop("Photos B");
    const bProduct = await product(b);
    const { fileId } = await uploadProductImage(b, { productId: bProduct.id, bytes: await png() });
    expect(await codeOf(readImage(a, { fileId }))).toBe("NOT_FOUND");
    expect(await codeOf(removeImage(a, { fileId }))).toBe("NOT_FOUND");
    expect(await codeOf(uploadProductImage(a, { productId: bProduct.id, bytes: await png() }))).toBe("NOT_FOUND");
    expect((await readImage(b, { fileId })).bytes.byteLength).toBeGreaterThan(0);
  });
});
