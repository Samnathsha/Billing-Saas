import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AddCustomerForm } from "@/components/forms/customer-forms";
import { NotAllowed } from "@/components/not-allowed";
import { formatPaise } from "@/lib/money";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { listCustomers, type CustomerDto } from "@/modules/parties";
import { GST_STATES } from "@/modules/tax";
import { addCustomerFormAction } from "@/app/(app)/customers/actions";

export const metadata: Metadata = { title: "Customers" };

export default async function CustomersPage({ searchParams }: PageProps<"/customers">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const includeArchived = sp.archived === "1";
  let customers: CustomerDto[];
  try {
    customers = await listCustomers(who.ctx, { q, includeArchived });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    throw error;
  }
  const owed = customers.reduce((sum, c) => sum + c.balancePaise, 0);
  return (
    <main className="flex max-w-4xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
      <form method="get" className="flex flex-wrap items-center gap-2" role="search">
        <input name="q" defaultValue={q} placeholder="Search name, phone or GSTIN" aria-label="Search customers" className="h-8 w-72 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" name="archived" value="1" defaultChecked={includeArchived} /> Show archived
        </label>
        <button type="submit" className="rounded-lg border px-3 text-sm">Search</button>
      </form>
      {customers.length === 0 ? <p className="text-sm text-muted-foreground">{q === "" ? "No customers yet." : "Nothing found."}</p> : null}
      {customers.length > 0 ? (
        <>
          <table className="w-full rounded-lg border text-sm" aria-label="Customers">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-2 font-medium">Name</th>
                <th className="p-2 font-medium">Phone</th>
                <th className="p-2 text-right font-medium">Owes us</th>
                <th className="p-2 text-right font-medium">Credit limit</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {customers.map((c) => (
                <tr key={c.id}>
                  <td className="p-2">
                    <Link href={`/customers/${c.id}`} className="underline">{c.name}</Link>
                    {c.active ? "" : <span className="text-muted-foreground"> (archived)</span>}
                  </td>
                  <td className="p-2">{c.phone ?? ""}</td>
                  <td className="p-2 text-right tabular-nums">{c.balancePaise === 0 ? "" : formatPaise(c.balancePaise)}</td>
                  <td className="p-2 text-right tabular-nums">{c.creditLimitPaise === 0 ? "No credit" : formatPaise(c.creditLimitPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-sm">Owed on this list: {formatPaise(owed)}</p>
        </>
      ) : null}
      {who.permissions.includes("sales.create") ? (
        <AddCustomerForm states={[...GST_STATES].map(([code, name]) => ({ code, name }))} canGiveCredit={who.permissions.includes("discounts.above_limit")} save={addCustomerFormAction} />
      ) : null}
    </main>
  );
}
