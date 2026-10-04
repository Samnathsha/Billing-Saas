"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { findVariantsByCode } from "@/modules/catalog";
import { createPurchase, createPurchaseReturn, voidPurchase } from "@/modules/purchasing";
import { errorMessage, formRupees, formSerials, formString, LOGGED_OUT, memberCtx, type ActionState } from "@/app/(app)/_shared/action-result";

// Purchase screens. The services check permission and every value; this
// only turns typed rupees into paise and item codes into items.

const CODE = /^[A-Za-z0-9._/-]{1,64}$/;

export async function createPurchaseAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  const rows = formString(form, "rows").split(",").filter((r) => /^\d{1,3}$/.test(r)).slice(0, 200);
  const codes = rows.map((r) => formString(form, `code-${r}`));
  const bad = codes.find((c) => !CODE.test(c));
  if (bad !== undefined) return { error: `"${bad.slice(0, 64)}" is not a SKU or barcode.`, done: null };
  const payAmount = formRupees(form, "payAmount");
  if (payAmount === -1) return { error: "Enter the amount paid in rupees, e.g. 5000 or 5000.50.", done: null };
  const badPrice = rows.findIndex((r) => formRupees(form, `price-${r}`) === null || formRupees(form, `price-${r}`) === -1);
  if (badPrice !== -1) return { error: `Line ${String(badPrice + 1)}: enter the price in rupees, e.g. 450 or 450.50.`, done: null };

  let names: Map<string, string> | undefined;
  let purchaseId: string;
  try {
    const found = await findVariantsByCode(ctx, { codes });
    const missing = codes.find((c) => !found.has(c));
    if (missing !== undefined) return { error: `No item has the SKU or barcode "${missing}".`, done: null };
    names = new Map([...found.values()].map((v) => [v.variantId, v.name]));
    ({ purchaseId } = await createPurchase(ctx, {
      idempotencyKey: formString(form, "idempotencyKey"),
      supplierId: formString(form, "supplierId"),
      branchId: formString(form, "branchId"),
      supplierInvoiceNumber: formString(form, "billNumber"),
      invoiceDate: formString(form, "billDate"),
      note: formString(form, "note"),
      lines: rows.map((r) => ({
        variantId: found.get(formString(form, `code-${r}`))?.variantId,
        quantity: formString(form, `qty-${r}`),
        unitPricePaise: formRupees(form, `price-${r}`),
        taxRate: formString(form, `rate-${r}`),
        serials: formSerials(form, `serials-${r}`),
      })),
      payment: payAmount === null || payAmount === 0 ? null : { amountPaise: payAmount, method: formString(form, "method"), reference: formString(form, "reference") },
    }));
  } catch (error) {
    return { error: errorMessage(error, names), done: null };
  }
  revalidatePath("/purchases");
  revalidatePath("/suppliers", "layout");
  revalidatePath("/inventory");
  redirect(`/purchases/${purchaseId}?saved=1`);
}

export async function voidPurchaseAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  if (form.get("confirm") !== "on") return { error: "Tick the box to confirm.", done: null };
  const purchaseId = formString(form, "purchaseId");
  try {
    await voidPurchase(ctx, { idempotencyKey: formString(form, "idempotencyKey"), purchaseId, reason: formString(form, "reason") });
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/purchases", "layout");
  revalidatePath("/suppliers", "layout");
  revalidatePath("/inventory");
  return { error: null, done: "Purchase voided." };
}

export async function purchaseReturnAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  const lines = new Map<string, { quantity: string; serials: string[] }>();
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") continue;
    const qty = /^qty-([0-9a-f-]{36})$/.exec(key);
    if (qty?.[1] !== undefined && value.trim() !== "" && value.trim() !== "0") lines.set(qty[1], { quantity: value.trim(), serials: [] });
    const serial = /^serial-([0-9a-f-]{36})$/.exec(key);
    if (serial?.[1] !== undefined) {
      const line = lines.get(serial[1]) ?? { quantity: "0", serials: [] };
      line.serials.push(value);
      line.quantity = String(line.serials.length);
      lines.set(serial[1], line);
    }
  }
  if (lines.size === 0) return { error: "Enter what goes back on at least one line.", done: null };
  const purchaseId = formString(form, "purchaseId");
  try {
    await createPurchaseReturn(ctx, {
      idempotencyKey: formString(form, "idempotencyKey"),
      purchaseId,
      reason: formString(form, "reason"),
      reference: formString(form, "reference"),
      lines: [...lines].map(([purchaseItemId, l]) => ({ purchaseItemId, quantity: l.quantity, serials: l.serials })),
    });
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/purchases", "layout");
  revalidatePath("/suppliers", "layout");
  revalidatePath("/inventory");
  redirect(`/purchases/${purchaseId}?returned=1`);
}
