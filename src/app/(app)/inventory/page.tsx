import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NotAllowed } from "@/components/not-allowed";
import { decimalPaiseToPaise, formatPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { listProducts, variantLabel } from "@/modules/catalog";
import { getStockLevels, type StockLevelDto } from "@/modules/inventory";
import { listBranchChoices } from "@/modules/tenants";

export const metadata: Metadata = { title: "Stock" };

// Stock per item and branch. Average cost only for "View cost price and
// profit" (the service leaves it out otherwise).
export default async function StockPage({ searchParams }: PageProps<"/inventory">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const pageParam = Number(sp.page ?? "1");
  let data;
  try {
    const result = await listProducts(who.ctx, { page: Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1, q });
    const levels = await getStockLevels(who.ctx, { variantIds: result.products.flatMap((p) => p.variants.map((v) => v.id)) });
    const branches = (await listBranchChoices(who.ctx)).filter((b) => b.open);
    data = { result, levels, branches };
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    throw error;
  }
  const { result, levels, branches } = data;
  const levelOf = new Map<string, StockLevelDto>(levels.map((l) => [`${l.variantId}|${l.branchId}`, l]));
  const canAdjust = who.permissions.includes("stock.adjust");
  const showCost = who.permissions.includes("costs.view");
  // Average cost is per branch; shown for the first branch that has the item.
  const costOf = (variantId: string): string | undefined => levels.find((l) => l.variantId === variantId && l.averageCostPaise !== undefined)?.averageCostPaise;

  return (
    <main className="flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Stock</h1>
        {canAdjust ? (
          <div className="flex gap-3 text-sm">
            <Link href="/inventory/opening" className="underline">Opening stock</Link>
            <Link href="/inventory/adjust" className="underline">Adjust stock</Link>
          </div>
        ) : null}
      </div>
      <form method="get" className="flex gap-2" role="search">
        <input name="q" defaultValue={q} placeholder="Search name or SKU" aria-label="Search stock" className="h-8 w-80 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
        <button type="submit" className="rounded-lg border px-3 text-sm">Search</button>
      </form>
      {result.total === 0 ? <p className="text-sm text-muted-foreground">{q === "" ? "No products yet." : "Nothing found."}</p> : null}
      {result.total > 0 ? (
        <div className="table-scroll">
          <table className="w-full text-sm" aria-label="Stock levels">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-2 font-medium">Item</th>
                <th className="p-2 font-medium">SKU</th>
                {branches.map((b) => (
                  <th key={b.id} className="p-2 text-right font-medium">{b.name}</th>
                ))}
                {showCost ? <th className="p-2 text-right font-medium">Average cost</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y">
              {result.products.flatMap((p) =>
                p.variants.map((v) => {
                  const cost = costOf(v.id);
                  const label = variantLabel(v.attributes);
                  return (
                    <tr key={v.id} aria-label={`${p.name}${label === "" ? "" : ` ${label}`}`}>
                      <td className="p-2">
                        {p.name}
                        {label === "" ? "" : <span className="text-muted-foreground"> · {label}</span>}
                        {v.active && p.active ? "" : <span className="text-muted-foreground"> (archived)</span>}
                      </td>
                      <td className="p-2 text-muted-foreground">{v.sku}</td>
                      {branches.map((b) => (
                        <td key={b.id} className="p-2 text-right tabular-nums">{formatQuantity(levelOf.get(`${v.id}|${b.id}`)?.quantity ?? "0")}</td>
                      ))}
                      {showCost ? <td className="p-2 text-right tabular-nums">{cost === undefined ? "–" : formatPaise(decimalPaiseToPaise(cost))}</td> : null}
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      ) : null}
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
