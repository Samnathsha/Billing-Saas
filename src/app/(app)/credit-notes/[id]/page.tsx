import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PrintButton } from "@/components/forms/invoice-forms";
import { NotAllowed } from "@/components/not-allowed";
import { formatPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { getCreditNote, SalesError, type CreditNoteDto } from "@/modules/sales";
import { GST_STATES } from "@/modules/tax";

export const metadata: Metadata = { title: "Credit note" };

const REFUND: Record<string, string> = { cash: "Cash", card: "Card", upi: "UPI", store_credit: "Store credit (customer's account)" };
const stateName = (code: string): string => `${GST_STATES.get(code) ?? "?"} (${code})`;

// The credit note as printed: from its own saved rows and the original
// bill's saved copy of seller and buyer (open question 9).
export default async function CreditNotePage({ params, searchParams }: PageProps<"/credit-notes/[id]">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let note: CreditNoteDto;
  try {
    note = await getCreditNote(who.ctx, { creditNoteId: id });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    if (error instanceof SalesError) notFound();
    throw error;
  }
  return (
    <main className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href={`/sales/${note.invoice.id}`} className="text-sm underline">← Bill {note.invoice.number}</Link>
        <PrintButton />
      </div>
      {sp.saved === "1" ? (
        <p role="status" className="rounded-lg border bg-muted/40 p-3 text-sm print:hidden">
          Return saved. {note.refundMethod === "store_credit" ? "The amount is on the customer's account." : `Give back ${formatPaise(note.refundPaise)}.`}
        </p>
      ) : null}
      <article className="flex flex-col gap-4 rounded-lg border p-4 print:border-0 print:p-0" aria-label="Credit note">
        <header className="flex flex-wrap justify-between gap-4">
          <div>
            <p className="text-lg font-semibold">{note.seller.name}</p>
            {note.seller.address === null ? null : <p className="text-sm">{note.seller.address}</p>}
            <p className="text-sm">State: {stateName(note.seller.stateCode)}</p>
            {note.seller.gstin === null ? null : <p className="text-sm">GSTIN: {note.seller.gstin}</p>}
          </div>
          <div className="text-right">
            <h1 className="text-xl font-semibold">Credit Note</h1>
            <p className="text-sm">
              No. <strong>{note.number}</strong>
            </p>
            <p className="text-sm">Date {note.creditNoteDate}</p>
            <p className="text-sm">
              Against bill {note.invoice.number} of {note.invoice.invoiceDate}
            </p>
          </div>
        </header>
        <section className="text-sm" aria-label="Buyer">
          <p>
            Customer: <strong>{note.buyer.name ?? "Walk-in customer"}</strong>
            {note.buyer.phone === null ? "" : ` · ${note.buyer.phone}`}
          </p>
          {note.buyer.address === null ? null : <p>{note.buyer.address}</p>}
          {note.buyer.gstin === null ? null : <p>GSTIN: {note.buyer.gstin}</p>}
          <p>Place of supply: {stateName(note.placeOfSupply)}</p>
          <p>Reason: {note.reason}{note.outsideWindow ? " (after the return period, approved by a manager)" : ""}</p>
        </section>
        <table className="w-full text-sm" aria-label="Returned items">
          <thead className="border-y text-left">
            <tr>
              <th className="p-1 font-medium">#</th>
              <th className="p-1 font-medium">Item</th>
              <th className="p-1 font-medium">HSN</th>
              <th className="p-1 text-right font-medium">Qty</th>
              {note.chargesGst ? (
                <>
                  <th className="p-1 text-right font-medium">Taxable</th>
                  <th className="p-1 text-right font-medium">GST</th>
                  {note.interState ? <th className="p-1 text-right font-medium">IGST</th> : (
                    <>
                      <th className="p-1 text-right font-medium">CGST</th>
                      <th className="p-1 text-right font-medium">SGST</th>
                    </>
                  )}
                </>
              ) : null}
              <th className="p-1 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {note.items.map((i) => (
              <tr key={i.lineNumber}>
                <td className="p-1">{i.lineNumber}</td>
                <td className="p-1">
                  {i.name}
                  <span className="block text-xs text-muted-foreground">
                    {i.sku}
                    {i.serial === null ? "" : ` · IMEI ${i.serial}`}
                    {i.resellable ? "" : " · damaged"}
                  </span>
                </td>
                <td className="p-1">{i.hsnCode ?? ""}</td>
                <td className="p-1 text-right tabular-nums">
                  {formatQuantity(i.quantity)} {i.unitCode}
                </td>
                {note.chargesGst ? (
                  <>
                    <td className="p-1 text-right tabular-nums">{formatPaise(i.taxablePaise)}</td>
                    <td className="p-1 text-right tabular-nums">{i.taxLabel}</td>
                    {note.interState ? <td className="p-1 text-right tabular-nums">{formatPaise(i.igstPaise)}</td> : (
                      <>
                        <td className="p-1 text-right tabular-nums">{formatPaise(i.cgstPaise)}</td>
                        <td className="p-1 text-right tabular-nums">{formatPaise(i.sgstPaise)}</td>
                      </>
                    )}
                  </>
                ) : null}
                <td className="p-1 text-right tabular-nums">{formatPaise(i.totalPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="ml-auto grid w-full max-w-xs grid-cols-2 gap-1 text-sm" aria-label="Totals">
          {note.chargesGst ? (
            <>
              <dt>Taxable value</dt>
              <dd className="text-right tabular-nums">{formatPaise(note.taxablePaise)}</dd>
              {note.interState ? (
                <>
                  <dt>IGST</dt>
                  <dd className="text-right tabular-nums">{formatPaise(note.igstPaise)}</dd>
                </>
              ) : (
                <>
                  <dt>CGST</dt>
                  <dd className="text-right tabular-nums">{formatPaise(note.cgstPaise)}</dd>
                  <dt>SGST</dt>
                  <dd className="text-right tabular-nums">{formatPaise(note.sgstPaise)}</dd>
                </>
              )}
            </>
          ) : null}
          {note.roundOffPaise !== 0 ? (
            <>
              <dt>Round off</dt>
              <dd className="text-right tabular-nums">{formatPaise(note.roundOffPaise)}</dd>
            </>
          ) : null}
          <dt className="font-semibold">Refund</dt>
          <dd className="text-right font-semibold tabular-nums">{formatPaise(note.refundPaise)}</dd>
          <dt>Paid back as</dt>
          <dd className="text-right">{REFUND[note.refundMethod] ?? note.refundMethod}</dd>
        </dl>
        <p className="mt-6 text-right text-sm">For {note.seller.name} · Authorised signatory</p>
      </article>
    </main>
  );
}
