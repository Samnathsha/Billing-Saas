"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import type { ImportState } from "@/components/forms/import-form";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { ImportError, importProductsCsv } from "@/modules/catalog";

const MAX_BYTES = 2 * 1024 * 1024;

export async function importAction(_p: ImportState, form: FormData): Promise<ImportState> {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") return { message: "Please log in again.", errors: [], done: false };
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { message: "Choose a CSV file.", errors: [], done: false };
  if (file.size > MAX_BYTES) return { message: "The file is larger than 2 MB.", errors: [], done: false };
  try {
    const result = await importProductsCsv(who.ctx, { csv: await file.text() });
    revalidatePath("/catalog/products");
    return { message: `Imported ${String(result.products)} products with ${String(result.variants)} variants.`, errors: [], done: true };
  } catch (error) {
    if (error instanceof ImportError) return { message: error.message, errors: error.errors, done: false };
    if (error instanceof PermissionDeniedError) return { message: error.message, errors: [], done: false };
    if (error instanceof ZodError) return { message: error.issues[0]?.message ?? "Please check the file.", errors: [], done: false };
    console.error("import failed", error instanceof Error ? error.name : "unknown");
    return { message: "Something went wrong. Nothing was imported.", errors: [], done: false };
  }
}
