import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NotAllowed } from "@/components/not-allowed";
import { formatPaise } from "@/lib/money";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { findByBarcode, listProducts } from "@/modules/catalog";

export const metadata: Metadata = { title: "Products" };

export default async function ProductsPage({ searchParams }: PageProps<"/catalog/products">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  const sp = await searchParams;
  const pageParam = Number(sp.page ?? "1");
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  let result: Awaited<ReturnType<typeof listProducts>>;
  try {
    // A scanned barcode goes straight to its item.
    if (/^[A-Za-z0-9-]{1,64}$/.test(q.trim())) {
      const hit = await findByBarcode(who.ctx, { code: q.trim() });
      if (hit !== null) redirect(`/catalog/products/${hit.productId}`);
    }
    result = await listProducts(who.ctx, { page: Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1, q });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    throw error;
  }
  const canManage = who.permissions.includes("products.manage");
  return (
    <main className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Link href="/catalog/lists" className="underline">Categories, brands, units</Link>
            <Link href="/catalog/import" className="underline">Import CSV</Link>
            <Link href="/catalog/products/new" className="action-primary">New product</Link>
          </div>
        ) : null}
      </div>
      <form method="get" className="flex gap-2" role="search">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search name, SKU, or scan a barcode"
          aria-label="Search products"
          autoFocus
          className="h-8 w-80 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        />
        <button type="submit" className="rounded-lg border px-3 text-sm">Search</button>
      </form>
      {result.total === 0 ? <p className="text-sm text-muted-foreground">{q === "" ? "No products yet." : "Nothing found."}</p> : null}
      <ul className="flex flex-col divide-y rounded-lg border" aria-label="Products">
        {result.products.map((p) => {
          const prices = p.variants.filter((v) => v.active).map((v) => v.sellingPricePaise);
          return (
            <li key={p.id} className="flex items-center justify-between gap-2 p-3 text-sm" aria-label={p.name}>
              <Link href={`/catalog/products/${p.id}`} className="font-medium underline">
                {p.name}
              </Link>
              <span className="text-muted-foreground">
                {p.variants.length} variant{p.variants.length === 1 ? "" : "s"}
                {prices.length > 0 ? ` · ${formatPaise(Math.min(...prices))}` : ""}
                {prices.length > 1 && Math.max(...prices) !== Math.min(...prices) ? ` – ${formatPaise(Math.max(...prices))}` : ""}
                {p.active ? "" : " · archived"}
              </span>
            </li>
          );
        })}
      </ul>
      {result.pages > 1 ? (
        <p className="text-sm">
          Page {result.page} of {result.pages}
          {result.page > 1 ? <Link href={`?q=${encodeURIComponent(q)}&page=${String(result.page - 1)}`} className="ml-3 underline">Previous</Link> : null}
          {result.page < result.pages ? <Link href={`?q=${encodeURIComponent(q)}&page=${String(result.page + 1)}`} className="ml-3 underline">Next</Link> : null}
        </p>
      ) : null}
    </main>
  );
}
