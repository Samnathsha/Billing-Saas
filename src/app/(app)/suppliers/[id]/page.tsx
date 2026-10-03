import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArchiveSupplierForm, EditSupplierForm, OpeningBalanceForm, SupplierPaymentForm } from "@/components/forms/supplier-forms";
import { NotAllowed } from "@/components/not-allowed";
import { formatPaise } from "@/lib/money";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { getSupplierStatement, PartyError, type SupplierStatementDto } from "@/modules/parties";
import { GST_STATES } from "@/modules/tax";
import { todayInIndia } from "@/app/(app)/_shared/today";
import { archiveSupplierAction, editSupplierAction, openingBalanceAction, supplierPaymentAction } from "@/app/(app)/suppliers/actions";
import { balanceText } from "@/app/(app)/_shared/format";

export const metadata: Metadata = { title: "Supplier" };

const ENTRY_NAMES: Record<string, string> = {
  opening: "Opening balance",
  purchase: "Purchase",
  payment: "Payment",
  void_reversal: "Purchase voided",
};

export default async function SupplierPage({ params }: PageProps<"/suppliers/[id]">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let statement: SupplierStatementDto;
  try {
    statement = await getSupplierStatement(who.ctx, { supplierId: id });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    if (error instanceof PartyError) notFound();
    throw error;
  }
  const { supplier, entries } = statement;
  const canManage = who.permissions.includes("purchases.create");
  const hasOpening = entries.some((e) => e.entryType === "opening");
  const states = [...GST_STATES].map(([code, name]) => ({ code, name }));
  return (
    <main className="flex max-w-4xl flex-col gap-4">
      <Link href="/suppliers" className="text-sm underline">← Suppliers</Link>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {supplier.name}
          {supplier.active ? "" : <span className="text-base font-normal text-muted-foreground"> (archived)</span>}
        </h1>
        <p className="text-lg tabular-nums" aria-label="Balance">{balanceText(supplier.balancePaise)}</p>
      </div>
      {canManage ? (
        <Link href={`/purchases/new?supplier=${supplier.id}`} className="self-start text-sm underline">
          New purchase from this supplier
        </Link>
      ) : null}
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Account</h2>
        {entries.length === 0 ? <p className="text-sm text-muted-foreground">Nothing yet.</p> : null}
        {entries.length > 0 ? (
          <table className="w-full rounded-lg border text-sm" aria-label="Supplier account">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-2 font-medium">Date</th>
                <th className="p-2 font-medium">What</th>
                <th className="p-2 font-medium">Note</th>
                <th className="p-2 text-right font-medium">We owe more</th>
                <th className="p-2 text-right font-medium">We owe less</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="p-2">{new Date(e.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
                  <td className="p-2">
                    {e.sourceType === "purchase" ? <Link href={`/purchases/${e.sourceId}`} className="underline">{ENTRY_NAMES[e.entryType] ?? e.entryType}</Link> : (ENTRY_NAMES[e.entryType] ?? e.entryType)}
                  </td>
                  <td className="p-2 text-muted-foreground">{e.note ?? ""}</td>
                  <td className="p-2 text-right tabular-nums">{e.amountPaise > 0 ? formatPaise(e.amountPaise) : ""}</td>
                  <td className="p-2 text-right tabular-nums">{e.amountPaise < 0 ? formatPaise(-e.amountPaise) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
      {canManage ? (
        <>
          <SupplierPaymentForm supplierId={supplier.id} idempotencyKey={randomUUID()} today={todayInIndia()} save={supplierPaymentAction} />
          {hasOpening ? null : <OpeningBalanceForm supplierId={supplier.id} idempotencyKey={randomUUID()} save={openingBalanceAction} />}
          <EditSupplierForm key={supplier.version} states={states} supplier={supplier} save={editSupplierAction} />
          <ArchiveSupplierForm id={supplier.id} active={supplier.active} save={archiveSupplierAction} />
        </>
      ) : null}
    </main>
  );
}
