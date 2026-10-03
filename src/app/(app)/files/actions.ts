"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { UploadState } from "@/components/forms/image-upload-form";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { FileError, ImageError, MAX_UPLOAD_BYTES, removeImage, uploadLogo, uploadProductImage } from "@/modules/files";

// Uploads. The business comes from the session; the file is checked by
// content and re-encoded by the files module.
async function run(work: (ctx: Extract<Awaited<ReturnType<typeof getRequestContext>>, { kind: "member" }>["ctx"]) => Promise<unknown>, path: string, done: string): Promise<UploadState> {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") return { error: "Please log in again.", info: null };
  try {
    await work(who.ctx);
  } catch (error) {
    if (error instanceof ImageError || error instanceof FileError || error instanceof PermissionDeniedError) return { error: error.message, info: null };
    console.error("upload failed", error instanceof Error ? error.name : "unknown");
    return { error: "Something went wrong. Please try again.", info: null };
  }
  revalidatePath(path);
  return { error: null, info: done };
}

const text = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

async function fileBytes(form: FormData): Promise<Uint8Array | null> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return null;
  // Refuse big files before reading them into memory.
  if (file.size > MAX_UPLOAD_BYTES) return new Uint8Array(MAX_UPLOAD_BYTES + 1);
  return new Uint8Array(await file.arrayBuffer());
}

export async function uploadLogoAction(_p: UploadState, form: FormData): Promise<UploadState> {
  const bytes = await fileBytes(form);
  if (bytes === null) return { error: "Choose an image.", info: null };
  return run((ctx) => uploadLogo(ctx, { bytes }), "/settings/business", "Logo saved.");
}

export async function uploadProductImageAction(_p: UploadState, form: FormData): Promise<UploadState> {
  const bytes = await fileBytes(form);
  if (bytes === null) return { error: "Choose an image.", info: null };
  const productId = text(form, "productId");
  return run((ctx) => uploadProductImage(ctx, { productId, bytes }), `/catalog/products/${productId}`, "Photo added.");
}

export async function removeImageAction(_p: UploadState, form: FormData): Promise<UploadState> {
  const path = text(form, "returnTo");
  return run((ctx) => removeImage(ctx, { fileId: text(form, "fileId") }), path.startsWith("/") && !path.startsWith("//") ? path : "/", "Removed.");
}
