import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AddListItemForm, ListItem } from "@/components/forms/catalog-list-forms";
import { NotAllowed } from "@/components/not-allowed";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { getCatalogLists, type CatalogListsDto } from "@/modules/catalog";
import {
  addBrandAction,
  addCategoryAction,
  addUnitAction,
  archiveItemAction,
  renameItemAction,
} from "./actions";

export const metadata: Metadata = { title: "Catalog lists" };

// "Manage products" only (Owner, Admin, Manager); getCatalogLists checks it.
export default async function CatalogListsPage() {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  let lists: CatalogListsDto;
  try {
    lists = await getCatalogLists(who.ctx);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    throw error;
  }
  const nameOf = new Map(lists.categories.map((c) => [c.id, c.name]));
  const mainCategories = lists.categories.filter((c) => c.parentId === null && c.active);
  return (
    <main className="flex max-w-3xl flex-col gap-8">
      <h1 className="text-2xl font-semibold tracking-tight">Catalog lists</h1>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Categories</h2>
        <AddListItemForm kind="category" action={addCategoryAction} parents={mainCategories} />
        <ul className="flex flex-col divide-y rounded-lg border" aria-label="Categories">
          {lists.categories.map((c) => (
            <ListItem
              key={c.id}
              kind="category"
              item={c}
              detail={c.parentId === null ? "" : `inside ${nameOf.get(c.parentId) ?? "?"}`}
              rename={renameItemAction}
              archive={archiveItemAction}
            />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Brands</h2>
        <AddListItemForm kind="brand" action={addBrandAction} />
        <ul className="flex flex-col divide-y rounded-lg border" aria-label="Brands">
          {lists.brands.map((b) => (
            <ListItem key={b.id} kind="brand" item={b} rename={renameItemAction} archive={archiveItemAction} />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Units</h2>
        <AddListItemForm kind="unit" action={addUnitAction} />
        <ul className="flex flex-col divide-y rounded-lg border" aria-label="Units">
          {lists.units.map((u) => (
            <ListItem
              key={u.id}
              kind="unit"
              item={u}
              detail={`${u.code}${u.allowsFraction ? " · fractions" : " · whole only"}`}
              rename={renameItemAction}
              archive={archiveItemAction}
            />
          ))}
        </ul>
      </section>
    </main>
  );
}
