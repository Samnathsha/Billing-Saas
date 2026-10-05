import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NotAllowed } from "@/components/not-allowed";
import { formatPaise } from "@/lib/money";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { listPurchases, type PurchaseDto } from "@/modules/purchasing";

export const metadata: Metadata = { title: "Purchases" };

export default async function PurchasesPage() {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  let purchases: PurchaseDto[];
  try {
    purchases = await listPurchases(who.ctx);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    throw error;
  }
  const canBuy = who.permissions.includes("purchases.create");
  return (
    <main className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Purchases</h1>
        <div className="flex gap-3 text-sm">
          <Link href="/suppliers" className="underline">Suppliers</Link>
          {canBuy ? <Link href="/purchases/new" className="underline">New purchase</Link> : null}
        </div>
      </div>
      {purchases.length === 0 ? <p className="text-sm text-muted-foreground">No purchases yet.</p> : null}
      {purchases.length > 0 ? (
        <div className="table-scroll"><table className="w-full text-sm" aria-label="Purchases">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-2 font-medium">Bill date</th>
              <th className="p-2 font-medium">Supplier</th>
              <th className="p-2 font-medium">Bill no.</th>
              <th className="p-2 text-right font-medium">Total</th>
              <th className="p-2 text-right font-medium">Paid with bill</th>
              <th className="p-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {purchases.map((p) => (
              <tr key={p.id}>
                <td className="p-2">{p.invoiceDate}</td>
                <td className="p-2">{p.supplierName}</td>
                <td className="p-2">
                  <Link href={`/purchases/${p.id}`} className="underline">{p.supplierInvoiceNumber}</Link>
                </td>
                <td className="p-2 text-right tabular-nums">{formatPaise(p.totalPaise)}</td>
                <td className="p-2 text-right tabular-nums">{p.paidPaise > 0 ? formatPaise(p.paidPaise) : ""}</td>
                <td className="p-2">{p.status === "voided" ? "Voided" : "Posted"}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : null}
    </main>
  );
}
