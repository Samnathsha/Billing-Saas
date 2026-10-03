import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { NewProductForm } from "@/components/forms/product-form";
import { NotAllowed } from "@/components/not-allowed";
import { getRequestContext, hasPermission, PermissionDeniedError } from "@/modules/auth";
import { getCatalogLists, type CatalogListsDto } from "@/modules/catalog";
import { createProductAction } from "@/app/(app)/catalog/products/actions";

export const metadata: Metadata = { title: "New product" };

export default async function NewProductPage() {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  let lists: CatalogListsDto;
  try {
    lists = await getCatalogLists(who.ctx);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    throw error;
  }
  const active = <T extends { active: boolean }>(items: T[]) => items.filter((i) => i.active);
  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New product</h1>
      <NewProductForm
        save={createProductAction}
        options={{
          template: lists.template,
          categories: active(lists.categories),
          brands: active(lists.brands),
          units: active(lists.units),
          taxCategories: lists.taxCategories,
          canSetCost: await hasPermission(who.ctx, "costs.view"),
        }}
      />
    </main>
  );
}
