import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AddSupplierForm } from "@/components/forms/supplier-forms";
import { NotAllowed } from "@/components/not-allowed";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { listSuppliers, type SupplierDto } from "@/modules/parties";
import { GST_STATES } from "@/modules/tax";
import { balanceText } from "@/app/(app)/_shared/format";
import { addSupplierAction } from "@/app/(app)/suppliers/actions";

export const metadata: Metadata = { title: "Suppliers" };

export default async function SuppliersPage({ searchParams }: PageProps<"/suppliers">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const includeArchived = sp.archived === "1";
  let suppliers: SupplierDto[];
  try {
    suppliers = await listSuppliers(who.ctx, { q, includeArchived });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    throw error;
  }
  const canManage = who.permissions.includes("purchases.create");
  const owed = suppliers.reduce((sum, s) => sum + s.balancePaise, 0);
  return (
    <main className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Suppliers</h1>
        <Link href="/purchases" className="text-sm underline">Purchases</Link>
      </div>
      <form method="get" className="flex flex-wrap items-center gap-2" role="search">
        <input name="q" defaultValue={q} placeholder="Search name, phone or GSTIN" aria-label="Search suppliers" className="h-8 w-72 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" name="archived" value="1" defaultChecked={includeArchived} /> Show archived
        </label>
        <button type="submit" className="rounded-lg border px-3 text-sm">Search</button>
      </form>
      {suppliers.length === 0 ? <p className="text-sm text-muted-foreground">{q === "" ? "No suppliers yet." : "Nothing found."}</p> : null}
      {suppliers.length > 0 ? (
        <>
          <ul className="flex flex-col divide-y rounded-lg border" aria-label="Suppliers">
            {suppliers.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm" aria-label={s.name}>
                <Link href={`/suppliers/${s.id}`} className="font-medium underline">
                  {s.name}
                </Link>
                <span className="text-muted-foreground">
                  {s.phone ?? ""}
                  {s.active ? "" : " · archived"}
                </span>
                <span className="tabular-nums">{balanceText(s.balancePaise)}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm">Total on this list: {balanceText(owed)}</p>
        </>
      ) : null}
      {canManage ? <AddSupplierForm states={[...GST_STATES].map(([code, name]) => ({ code, name }))} save={addSupplierAction} /> : null}
    </main>
  );
}
