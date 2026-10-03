"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import type { ListFormState } from "@/components/forms/catalog-list-forms";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import {
  CatalogError,
  createBrand,
  createCategory,
  createUnit,
  renameListItem,
  setListItemArchived,
} from "@/modules/catalog";

// Catalog list changes. Business and user come from the session; the forms
// carry only names, codes and ids, which the services check.

type MemberCtx = Extract<Awaited<ReturnType<typeof getRequestContext>>, { kind: "member" }>["ctx"];

async function run(work: (ctx: MemberCtx) => Promise<unknown>): Promise<ListFormState> {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") return { error: "Please log in again." };
  try {
    await work(who.ctx);
  } catch (error) {
    if (error instanceof CatalogError || error instanceof PermissionDeniedError) return { error: error.message };
    if (error instanceof ZodError) return { error: error.issues[0]?.message ?? "Please check the form." };
    console.error("catalog list action failed", error instanceof Error ? error.name : "unknown");
    return { error: "Something went wrong. Please try again." };
  }
  revalidatePath("/catalog/lists");
  return { error: null };
}

const field = (form: FormData, name: string): unknown => form.get(name);

export async function addCategoryAction(_p: ListFormState, form: FormData): Promise<ListFormState> {
  return run((ctx) => createCategory(ctx, { name: field(form, "name"), parentId: field(form, "parentId") }));
}

export async function addBrandAction(_p: ListFormState, form: FormData): Promise<ListFormState> {
  return run((ctx) => createBrand(ctx, { name: field(form, "name") }));
}

export async function addUnitAction(_p: ListFormState, form: FormData): Promise<ListFormState> {
  return run((ctx) =>
    createUnit(ctx, { name: field(form, "name"), code: field(form, "code"), allowsFraction: form.get("allowsFraction") === "on" }),
  );
}

export async function renameItemAction(_p: ListFormState, form: FormData): Promise<ListFormState> {
  return run((ctx) => renameListItem(ctx, { kind: field(form, "kind"), id: field(form, "id"), name: field(form, "name") }));
}

export async function archiveItemAction(_p: ListFormState, form: FormData): Promise<ListFormState> {
  return run((ctx) =>
    setListItemArchived(ctx, { kind: field(form, "kind"), id: field(form, "id"), archived: form.get("archived") === "yes" }),
  );
}
