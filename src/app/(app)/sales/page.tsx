import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NotAllowed } from "@/components/not-allowed";
import { formatPaise } from "@/lib/money";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { listInvoices, type InvoiceListItemDto } from "@/modules/sales";
import { todayInIndia } from "@/app/(app)/_shared/today";

export const metadata: Metadata = { title: "Bills" };

// Bills of one day (today by default).
export default async function SalesPage({ searchParams }: PageProps<"/sales">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  const sp = await searchParams;
  const day = typeof sp.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.day) ? sp.day : todayInIndia();
  let bills: InvoiceListItemDto[];
  try {
    bills = await listInvoices(who.ctx, { day });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    throw error;
  }
  const posted = bills.filter((b) => b.status === "posted");
  const total = posted.reduce((sum, b) => sum + b.payablePaise, 0);
  return (
    <main className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Bills</h1>
        {who.permissions.includes("sales.create") ? <Link href="/pos" className="text-sm underline">New bill</Link> : null}
      </div>
      <form method="get" className="flex items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          Day
          <input type="date" name="day" defaultValue={day} className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm" />
        </label>
        <button type="submit" className="h-8 rounded-lg border px-3 text-sm">Show</button>
      </form>
      <p className="text-sm">
        {posted.length} bill{posted.length === 1 ? "" : "s"}, {formatPaise(total)}
        {bills.length > posted.length ? ` (${String(bills.length - posted.length)} voided, not counted)` : ""}
      </p>
      {bills.length === 0 ? <p className="text-sm text-muted-foreground">No bills on this day.</p> : null}
      {bills.length > 0 ? (
        <div className="table-scroll"><table className="w-full text-sm" aria-label="Bills">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-2 font-medium">Bill</th>
              <th className="p-2 font-medium">Time</th>
              <th className="p-2 font-medium">Customer</th>
              <th className="p-2 text-right font-medium">Amount</th>
              <th className="p-2 text-right font-medium">On account</th>
              <th className="p-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {bills.map((b) => (
              <tr key={b.id}>
                <td className="p-2">
                  <Link href={`/sales/${b.id}`} className="underline">{b.number}</Link>
                </td>
                <td className="p-2">{new Date(b.createdAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}</td>
                <td className="p-2">{b.buyerName ?? "Walk-in"}</td>
                <td className="p-2 text-right tabular-nums">{formatPaise(b.payablePaise)}</td>
                <td className="p-2 text-right tabular-nums">{b.creditPaise > 0 ? formatPaise(b.creditPaise) : ""}</td>
                <td className="p-2">{b.status === "voided" ? "Voided" : "Posted"}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : null}
    </main>
  );
}
