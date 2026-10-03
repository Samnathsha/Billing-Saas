"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createCustomer, setCustomerArchived, updateCustomer } from "@/modules/parties";
import { recordCustomerPayment } from "@/modules/sales";
import { errorMessage, formRupees, formString, LOGGED_OUT, memberCtx, type ActionState } from "@/app/(app)/_shared/action-result";

// Customer screens. The services check permission (credit limits: Manager
// and above) and every value.

const fields = (form: FormData) => ({
  name: formString(form, "name"),
  phone: formString(form, "phone"),
  gstin: formString(form, "gstin"),
  stateCode: formString(form, "stateCode"),
  address: formString(form, "address"),
  creditLimitPaise: formRupees(form, "creditLimit") ?? 0,
});

export async function addCustomerFormAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  let id: string;
  try {
    ({ id } = await createCustomer(ctx, fields(form)));
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/customers");
  redirect(`/customers/${id}`);
}

export async function editCustomerAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  try {
    await updateCustomer(ctx, { id: formString(form, "id"), version: Number(formString(form, "version")), ...fields(form) });
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/customers", "layout");
  return { error: null, done: "Saved." };
}

export async function archiveCustomerAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  try {
    await setCustomerArchived(ctx, { id: formString(form, "id"), archived: formString(form, "archived") === "yes" });
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/customers", "layout");
  return { error: null, done: null };
}

export async function customerPaymentAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await memberCtx();
  if (ctx === null) return LOGGED_OUT;
  const amount = formRupees(form, "amount") ?? -1;
  if (amount <= 0) return { error: "Enter the amount in rupees, e.g. 500 or 499.50.", done: null };
  try {
    await recordCustomerPayment(ctx, {
      idempotencyKey: formString(form, "idempotencyKey"),
      customerId: formString(form, "customerId"),
      branchId: formString(form, "branchId"),
      method: formString(form, "method"),
      amountPaise: amount,
      reference: formString(form, "reference"),
    });
  } catch (error) {
    return { error: errorMessage(error), done: null };
  }
  revalidatePath("/customers", "layout");
  return { error: null, done: "Payment saved." };
}
