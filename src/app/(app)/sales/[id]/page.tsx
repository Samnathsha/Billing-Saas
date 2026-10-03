import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PrintButton, VoidInvoiceForm } from "@/components/forms/invoice-forms";
import { NotAllowed } from "@/components/not-allowed";
import { formatPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { getInvoice, SalesError, type InvoiceDto } from "@/modules/sales";
import { GST_STATES } from "@/modules/tax";
import { todayInIndia } from "@/app/(app)/_shared/today";
import { voidInvoiceAction } from "@/app/(app)/sales/actions";

export const metadata: Metadata = { title: "Bill" };

const METHODS: Record<string, string> = { cash: "Cash", card: "Card", upi: "UPI" };
const stateName = (code: string): string => `${GST_STATES.get(code) ?? "?"} (${code})`;

// The bill as printed (business rules 4, 6; open questions 17, 37). Everything
// shown comes from the bill's own saved copy, never from today's settings.
export default async function InvoicePage({ params, searchParams }: PageProps<"/sales/[id]">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let bill: InvoiceDto;
  try {
    bill = await getInvoice(who.ctx, { invoiceId: id });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    if (error instanceof SalesError) notFound();
    throw error;
  }
  const canVoid = bill.status === "posted" && who.permissions.includes("invoices.void") && bill.invoiceDate === todayInIndia();
  const received = bill.payments.filter((p) => p.kind === "sale");
  const refunded = bill.payments.filter((p) => p.kind === "void");
  return (
    <main className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href="/sales" className="text-sm underline">← Bills</Link>
        <div className="flex gap-2">
          {who.permissions.includes("sales.create") ? (
            <Link href="/pos" className="inline-flex h-8 items-center rounded-lg border px-3 text-sm">New bill</Link>
          ) : null}
          <PrintButton />
        </div>
      </div>
      {sp.saved === "1" && bill.status === "posted" ? (
        <p role="status" className="rounded-lg border bg-muted/40 p-3 text-sm print:hidden">
          Bill saved.
        </p>
      ) : null}

      <article className="flex flex-col gap-4 rounded-lg border p-4 print:border-0 print:p-0" aria-label="Bill">
        <header className="flex flex-wrap justify-between gap-4">
          <div>
            <p className="text-lg font-semibold">{bill.seller.name}</p>
            {bill.seller.address === null ? null : <p className="text-sm">{bill.seller.address}</p>}
            <p className="text-sm">State: {stateName(bill.seller.stateCode)}</p>
            {bill.seller.gstin === null ? null : <p className="text-sm">GSTIN: {bill.seller.gstin}</p>}
          </div>
          <div className="text-right">
            <h1 className="text-xl font-semibold">{bill.chargesGst ? "Tax Invoice" : "Bill of Supply"}</h1>
            <p className="text-sm">
              No. <strong>{bill.number}</strong>
            </p>
            <p className="text-sm">Date {bill.invoiceDate}</p>
            {bill.status === "voided" ? <p className="font-semibold text-destructive">VOIDED: {bill.voidReason}</p> : null}
          </div>
        </header>

        <section className="text-sm" aria-label="Buyer">
          <p>
            Bill to: <strong>{bill.buyer.name ?? "Walk-in customer"}</strong>
            {bill.buyer.phone === null ? "" : ` · ${bill.buyer.phone}`}
          </p>
          {bill.buyer.address === null ? null : <p>{bill.buyer.address}</p>}
          {bill.buyer.gstin === null ? null : <p>GSTIN: {bill.buyer.gstin}</p>}
          <p>Place of supply: {stateName(bill.placeOfSupply)}</p>
        </section>

        <table className="w-full text-sm" aria-label="Bill lines">
          <thead className="border-y text-left">
            <tr>
              <th className="p-1 font-medium">#</th>
              <th className="p-1 font-medium">Item</th>
              <th className="p-1 font-medium">HSN</th>
              <th className="p-1 text-right font-medium">Qty</th>
              <th className="p-1 text-right font-medium">Rate</th>
              <th className="p-1 text-right font-medium">Discount</th>
              {bill.chargesGst ? (
                <>
                  <th className="p-1 text-right font-medium">Taxable</th>
                  <th className="p-1 text-right font-medium">GST</th>
                  {bill.interState ? <th className="p-1 text-right font-medium">IGST</th> : (
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
            {bill.items.map((i) => (
              <tr key={i.lineNumber}>
                <td className="p-1">{i.lineNumber}</td>
                <td className="p-1">
                  {i.productName}
                  {i.variantLabel === "" ? "" : ` · ${i.variantLabel}`}
                  <span className="block text-xs text-muted-foreground">
                    {i.sku}
                    {i.serial === null ? "" : ` · IMEI ${i.serial}`}
                  </span>
                </td>
                <td className="p-1">{i.hsnCode ?? ""}</td>
                <td className="p-1 text-right tabular-nums">
                  {formatQuantity(i.quantity)} {i.unitCode}
                </td>
                <td className="p-1 text-right tabular-nums">{formatPaise(i.unitPricePaise)}</td>
                <td className="p-1 text-right tabular-nums">{i.discountPaise > 0 ? formatPaise(i.discountPaise) : ""}</td>
                {bill.chargesGst ? (
                  <>
                    <td className="p-1 text-right tabular-nums">{formatPaise(i.taxablePaise)}</td>
                    <td className="p-1 text-right tabular-nums">{i.taxLabel}</td>
                    {bill.interState ? <td className="p-1 text-right tabular-nums">{formatPaise(i.igstPaise)}</td> : (
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
          <dt>Total of items</dt>
          <dd className="text-right tabular-nums">{formatPaise(bill.grossPaise)}</dd>
          {bill.discountPaise > 0 ? (
            <>
              <dt>Discount</dt>
              <dd className="text-right tabular-nums">−{formatPaise(bill.discountPaise)}</dd>
            </>
          ) : null}
          {bill.chargesGst ? (
            <>
              <dt>Taxable value</dt>
              <dd className="text-right tabular-nums">{formatPaise(bill.taxablePaise)}</dd>
              {bill.interState ? (
                <>
                  <dt>IGST</dt>
                  <dd className="text-right tabular-nums">{formatPaise(bill.igstPaise)}</dd>
                </>
              ) : (
                <>
                  <dt>CGST</dt>
                  <dd className="text-right tabular-nums">{formatPaise(bill.cgstPaise)}</dd>
                  <dt>SGST</dt>
                  <dd className="text-right tabular-nums">{formatPaise(bill.sgstPaise)}</dd>
                </>
              )}
            </>
          ) : null}
          {bill.roundOffPaise !== 0 ? (
            <>
              <dt>Round off</dt>
              <dd className="text-right tabular-nums">{formatPaise(bill.roundOffPaise)}</dd>
            </>
          ) : null}
          <dt className="font-semibold">Bill total</dt>
          <dd className="text-right font-semibold tabular-nums">{formatPaise(bill.payablePaise)}</dd>
          {received.map((p, index) => (
            <div key={`r${String(index)}`} className="contents">
              <dt>Paid by {METHODS[p.method] ?? p.method}</dt>
              <dd className="text-right tabular-nums">{formatPaise(p.amountPaise)}</dd>
            </div>
          ))}
          {bill.creditPaise > 0 ? (
            <>
              <dt>On account</dt>
              <dd className="text-right tabular-nums">{formatPaise(bill.creditPaise)}</dd>
            </>
          ) : null}
          {refunded.map((p, index) => (
            <div key={`v${String(index)}`} className="contents">
              <dt>Refunded ({METHODS[p.method] ?? p.method})</dt>
              <dd className="text-right tabular-nums">{formatPaise(-p.amountPaise)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          {bill.chargesGst ? (bill.pricesIncludeTax ? "Prices include GST." : "GST added to prices.") : "Composition or unregistered business: no GST charged."}
        </p>
        <p className="mt-6 text-right text-sm">For {bill.seller.name} · Authorised signatory</p>
      </article>

      {canVoid ? <VoidInvoiceForm invoiceId={bill.id} idempotencyKey={randomUUID()} save={voidInvoiceAction} /> : null}
    </main>
  );
}
