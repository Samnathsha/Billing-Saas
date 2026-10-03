import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { hasPermission, PermissionDeniedError, requirePermission, type Permission } from "@/modules/auth";
import { cleanImage } from "./images";
import * as repo from "./repo";
import * as store from "./store";

// Logo (Business and tax settings) and product photos (Manage products).
// Every image is checked by content and re-encoded first (images.ts), then
// stored privately under a random key; only logged-in members of the same
// business can view it (through /api/files/<id>). Audited.

const VIEW: readonly Permission[] = ["products.manage", "sales.create", "reports.view", "settings.manage"];
export const MAX_IMAGES_PER_PRODUCT = 8;

export type FileErrorCode = "NOT_FOUND" | "TOO_MANY_IMAGES";

export class FileError extends Error {
  constructor(public readonly code: FileErrorCode) {
    super(code === "NOT_FOUND" ? "This file was not found." : `At most ${String(MAX_IMAGES_PER_PRODUCT)} photos per product.`);
    this.name = "FileError";
  }
}

const bytes = z.instanceof(Uint8Array);
export const uploadLogoInput = z.strictObject({ bytes });
export const uploadProductImageInput = z.strictObject({ productId: z.uuid(), bytes });
export const fileIdInput = z.strictObject({ fileId: z.uuid() });

export async function uploadLogo(ctx: TenantContext, rawInput: unknown): Promise<{ fileId: string }> {
  await requirePermission(ctx, "settings.manage");
  const input = uploadLogoInput.parse(rawInput);
  const image = await cleanImage(input.bytes);
  const storageKey = `${ctx.tenantId}/${randomUUID()}.webp`;
  await store.putFile(storageKey, image.bytes);
  return withTenant(ctx, async (tx) => {
    // One logo at a time: the previous one is archived.
    for (const old of await repo.activeLogos(tx)) await repo.archiveFile(tx, old);
    const fileId = await repo.insertFile(tx, ctx, {
      purpose: "logo",
      productId: null,
      storageKey,
      sizeBytes: image.bytes.byteLength,
      width: image.width,
      height: image.height,
      sha256: image.sha256,
    });
    await repo.addAuditEntry(tx, ctx, { action: "file.logo_uploaded", entityId: fileId, before: null, after: { sha256: image.sha256 } });
    return { fileId };
  });
}

export async function uploadProductImage(ctx: TenantContext, rawInput: unknown): Promise<{ fileId: string }> {
  await requirePermission(ctx, "products.manage");
  const input = uploadProductImageInput.parse(rawInput);
  const image = await cleanImage(input.bytes);
  const storageKey = `${ctx.tenantId}/${randomUUID()}.webp`;
  return withTenant(ctx, async (tx) => {
    if (!(await repo.productExists(tx, input.productId))) throw new FileError("NOT_FOUND");
    if ((await repo.countProductImages(tx, input.productId)) >= MAX_IMAGES_PER_PRODUCT) throw new FileError("TOO_MANY_IMAGES");
    await store.putFile(storageKey, image.bytes);
    const fileId = await repo.insertFile(tx, ctx, {
      purpose: "product_image",
      productId: input.productId,
      storageKey,
      sizeBytes: image.bytes.byteLength,
      width: image.width,
      height: image.height,
      sha256: image.sha256,
    });
    await repo.addAuditEntry(tx, ctx, { action: "file.product_image_added", entityId: fileId, before: null, after: { productId: input.productId } });
    return { fileId };
  });
}

export async function removeImage(ctx: TenantContext, rawInput: unknown): Promise<void> {
  await requirePermission(ctx, ["products.manage", "settings.manage"]);
  const { fileId } = fileIdInput.parse(rawInput);
  await withTenant(ctx, async (tx) => {
    const row = await repo.lockFileRow(tx, fileId);
    if (row === undefined || row.archivedAt !== null) throw new FileError("NOT_FOUND");
    const needed: Permission = row.purpose === "logo" ? "settings.manage" : "products.manage";
    if (!(await hasPermission(ctx, needed))) throw new PermissionDeniedError(needed);
    await repo.archiveFile(tx, row);
    await repo.addAuditEntry(tx, ctx, { action: "file.removed", entityId: row.id, before: { purpose: row.purpose }, after: null });
  });
}

export async function readImage(ctx: TenantContext, rawInput: unknown): Promise<{ bytes: Buffer; contentType: string }> {
  await requirePermission(ctx, VIEW);
  const { fileId } = fileIdInput.parse(rawInput);
  const row = await withTenant(ctx, (tx) => repo.getFileRow(tx, fileId));
  if (row === undefined || row.archivedAt !== null) throw new FileError("NOT_FOUND");
  return { bytes: await store.getFile(row.storageKey), contentType: row.contentType };
}

export async function listImages(ctx: TenantContext, rawInput: unknown): Promise<{ logoId: string | null; productImageIds: string[] }> {
  await requirePermission(ctx, VIEW);
  const { productId } = z.strictObject({ productId: z.uuid().nullable() }).parse(rawInput);
  return withTenant(ctx, async (tx) => ({
    logoId: (await repo.activeLogos(tx)).at(-1)?.id ?? null,
    productImageIds: productId === null ? [] : (await repo.activeProductImages(tx, productId)).map((f) => f.id),
  }));
}
