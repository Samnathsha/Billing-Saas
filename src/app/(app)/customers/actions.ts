"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createCustomer, setCustomerArchived, updateCustomer } from "@/modules/parties";
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
