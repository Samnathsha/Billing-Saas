"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import type { ProductFormState } from "@/components/forms/product-form";
import { rupeesToPaise } from "@/lib/money";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import {
  addBarcode,
  changeVariantPrice,
  createProduct,
  ProductError,
  removeBarcode,
  setProductArchived,
  setVariantArchived,
} from "@/modules/catalog";

type MemberCtx = Extract<Awaited<ReturnType<typeof getRequestContext>>, { kind: "member" }>["ctx"];

function message(error: unknown): string {
  if (error instanceof ProductError || error instanceof PermissionDeniedError) return error.message;
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return issue === undefined ? "Please check the form." : `${issue.message}${issue.path.length > 0 ? ` (${issue.path.join(" ")})` : ""}`;
  }
  console.error("product action failed", error instanceof Error ? error.name : "unknown");
  return "Something went wrong. Please try again.";
}

async function member(): Promise<MemberCtx | null> {
  const who = await getRequestContext(await headers());
  return who.kind === "member" ? who.ctx : null;
}

const text = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};

// Rupees typed -> paise; a typing mistake becomes -1 so the service
// refuses it with a clear message instead of guessing.
const money = (form: FormData, name: string): number | null => {
  const raw = text(form, name);
  return raw === "" ? null : (rupeesToPaise(raw) ?? -1);
};

export async function createProductAction(_p: ProductFormState, form: FormData): Promise<ProductFormState> {
  const ctx = await member();
  if (ctx === null) return { error: "Please log in again." };
  const rows = text(form, "rows").split(",").filter((r) => r !== "");
  const fields = ["size", "colour", "fabric", "ram", "storage"];
  let id: string;
  try {
    const product = await createProduct(ctx, {
      name: text(form, "name"),
      categoryId: text(form, "categoryId"),
      brandId: text(form, "brandId"),
      unitId: text(form, "unitId"),
      taxCategory: text(form, "taxCategory"),
      hsnCode: text(form, "hsnCode"),
      trackSerial: form.get("trackSerial") === "on",
      warrantyMonths: text(form, "warrantyMonths") === "" ? null : Number(text(form, "warrantyMonths")),
      attributes: form.has("model") ? { model: text(form, "model") } : {},
      variants: rows.map((r) => {
        const attributes: Record<string, string> = {};
        for (const f of fields) if (form.has(`${f}-${r}`)) attributes[f] = text(form, `${f}-${r}`);
        return {
          sku: text(form, `sku-${r}`),
          attributes,
          sellingPricePaise: money(form, `price-${r}`) ?? -1,
          mrpPaise: money(form, `mrp-${r}`),
          ...(form.has(`cost-${r}`) ? { costPricePaise: money(form, `cost-${r}`) } : {}),
          reorderLevel: text(form, `reorder-${r}`),
        };
      }),
    });
    id = product.id;
  } catch (error) {
    return { error: message(error) };
  }
  revalidatePath("/catalog/products");
  redirect(`/catalog/products/${id}`);
}

export async function changePriceAction(_p: ProductFormState, form: FormData): Promise<ProductFormState> {
  const ctx = await member();
  if (ctx === null) return { error: "Please log in again." };
  try {
    await changeVariantPrice(ctx, {
      variantId: text(form, "variantId"),
      version: Number(text(form, "version")),
      sellingPricePaise: money(form, "price") ?? -1,
      mrpPaise: money(form, "mrp"),
      ...(form.has("cost") ? { costPricePaise: money(form, "cost") } : {}),
    });
  } catch (error) {
    return { error: message(error) };
  }
  revalidatePath(`/catalog/products/${text(form, "productId")}`);
  return { error: null };
}

export async function archiveAction(_p: ProductFormState, form: FormData): Promise<ProductFormState> {
  const ctx = await member();
  if (ctx === null) return { error: "Please log in again." };
  try {
    const input = { id: text(form, "id"), archived: form.get("archived") === "yes" };
    await (text(form, "kind") === "variant" ? setVariantArchived(ctx, input) : setProductArchived(ctx, input));
  } catch (error) {
    return { error: message(error) };
  }
  revalidatePath(`/catalog/products/${text(form, "productId")}`);
  return { error: null };
}

export async function barcodeAction(_p: ProductFormState, form: FormData): Promise<ProductFormState> {
  const ctx = await member();
  if (ctx === null) return { error: "Please log in again." };
  try {
    if (form.has("barcodeId")) await removeBarcode(ctx, { barcodeId: text(form, "barcodeId") });
    else await addBarcode(ctx, { variantId: text(form, "variantId"), code: text(form, "code") });
  } catch (error) {
    return { error: message(error) };
  }
  revalidatePath(`/catalog/products/${text(form, "productId")}`);
  return { error: null };
}
