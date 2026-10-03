"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupplier, recordSupplierOpeningBalance, setSupplierArchived, updateSupplier } from "@/modules/parties";
import { recordSupplierPayment } from "@/modules/purchasing";
import { errorMessage, formRupees, formString, LOGGED_OUT, memberCtx, type ActionState } from "@/app/(app)/_shared/action-result";

// Supplier screens. The services check permission and every value.

const supplierFields = (form: FormData) => ({
  name: formString(form, "name"),
  phone: formString(form, "phone"),
  gstin: formString(form, "gstin"),
  stateCode: formString(form, "stateCode"),
});

export async function addSupplierAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  let id: string;
  try {
    ({ id } = await createSupplier(ctx, supplierFields(form)));
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/suppliers");
  redirect(`/suppliers/${id}`);
}

export async function editSupplierAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  try {
    await updateSupplier(ctx, { id: formString(form, "id"), version: Number(formString(form, "version")), ...supplierFields(form) });
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/suppliers", "layout");
  return { error: null, done: "Saved." };
}

export async function archiveSupplierAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  try {
    await setSupplierArchived(ctx, { id: formString(form, "id"), archived: formString(form, "archived") === "yes" });
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/suppliers", "layout");
  return { error: null, done: null };
}

export async function openingBalanceAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  const amount = formRupees(form, "amount") ?? -1;
  if (amount <= 0) return { error: "Enter the amount in rupees, e.g. 12500 or 12500.50.", done: null };
  try {
    await recordSupplierOpeningBalance(ctx, {
      idempotencyKey: formString(form, "idempotencyKey"),
      supplierId: formString(form, "supplierId"),
      amountPaise: formString(form, "side") === "advance" ? -amount : amount,
      note: formString(form, "note"),
    });
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/suppliers", "layout");
  return { error: null, done: "Opening balance saved." };
}

export async function supplierPaymentAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  const amount = formRupees(form, "amount") ?? -1;
  if (amount <= 0) return { error: "Enter the amount in rupees, e.g. 5000 or 5000.50.", done: null };
  try {
    await recordSupplierPayment(ctx, {
      idempotencyKey: formString(form, "idempotencyKey"),
      supplierId: formString(form, "supplierId"),
      amountPaise: amount,
      method: formString(form, "method"),
      reference: formString(form, "reference"),
      paidOn: formString(form, "paidOn"),
    });
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/suppliers", "layout");
  return { error: null, done: "Payment saved." };
}
