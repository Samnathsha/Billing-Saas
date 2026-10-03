"use server";

import { revalidatePath } from "next/cache";
import { findVariantsByCode, type VariantSummaryDto } from "@/modules/catalog";
import { adjustStock, recordOpeningStock } from "@/modules/inventory";
import { errorMessage, formRupees, formSerials, formString, LOGGED_OUT, memberCtx, type ActionState, type MemberCtx } from "@/app/(app)/_shared/action-result";

// Stock screens. The form carries item codes and numbers only; the services
// check permission, branch, item and quantity.

const CODE = /^[A-Za-z0-9._/-]{1,64}$/;

type Lookup = { error: string } | { found: Map<string, VariantSummaryDto> };

async function resolve(ctx: MemberCtx, codes: string[]): Promise<Lookup> {
  const bad = codes.find((c) => !CODE.test(c));
  if (bad !== undefined) return { error: `"${bad.slice(0, 64)}" is not a SKU or barcode.` };
  const found = await findVariantsByCode(ctx, { codes });
  const missing = codes.find((c) => !found.has(c));
  if (missing !== undefined) return { error: `No item has the SKU or barcode "${missing}".` };
  return { found };
}

const namesOf = (found: Map<string, VariantSummaryDto>) => new Map([...found.values()].map((v) => [v.variantId, v.name]));

export async function openingStockAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  const rows = formString(form, "rows").split(",").filter((r) => /^\d{1,3}$/.test(r)).slice(0, 500);
  let names: Map<string, string> | undefined;
  try {
    const lookup = await resolve(ctx, rows.map((r) => formString(form, `code-${r}`)));
    if ("error" in lookup) return { error: lookup.error, done: null };
    names = namesOf(lookup.found);
    await recordOpeningStock(ctx, {
      idempotencyKey: formString(form, "idempotencyKey"),
      branchId: formString(form, "branchId"),
      lines: rows.map((r) => ({
        variantId: lookup.found.get(formString(form, `code-${r}`))?.variantId,
        quantity: formString(form, `qty-${r}`),
        unitCostPaise: formRupees(form, `cost-${r}`),
        serials: formSerials(form, `serials-${r}`),
      })),
    });
  } catch (error) {
    return { error: errorMessage(error, names), done: null };
  }
  revalidatePath("/inventory", "layout");
  return { error: null, done: `Opening stock saved (${String(rows.length)} line${rows.length === 1 ? "" : "s"}).` };
}

export async function adjustStockAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  let names: Map<string, string> | undefined;
  try {
    const code = formString(form, "code");
    const lookup = await resolve(ctx, [code]);
    if ("error" in lookup) return { error: lookup.error, done: null };
    names = namesOf(lookup.found);
    const serial = formString(form, "serial");
    const note = formString(form, "note");
    await adjustStock(ctx, {
      idempotencyKey: formString(form, "idempotencyKey"),
      branchId: formString(form, "branchId"),
      variantId: lookup.found.get(code)?.variantId,
      direction: formString(form, "direction"),
      quantity: formString(form, "quantity"),
      reasonCode: formString(form, "reasonCode"),
      ...(note === "" ? {} : { note }),
      ...(serial === "" ? {} : { serial }),
    });
  } catch (error) {
    return { error: errorMessage(error, names), done: null };
  }
  revalidatePath("/inventory", "layout");
  return { error: null, done: "Adjustment saved." };
}
