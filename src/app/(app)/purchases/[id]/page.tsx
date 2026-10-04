import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { VoidPurchaseForm } from "@/components/forms/purchase-forms";
import { NotAllowed } from "@/components/not-allowed";
import { decimalPaiseToPaise, formatPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { describeVariants, type VariantSummaryDto } from "@/modules/catalog";
import { getPurchase, getPurchaseReturnable, PurchaseError, type PurchaseDetailDto, type PurchaseReturnableDto } from "@/modules/purchasing";
import { voidPurchaseAction } from "@/app/(app)/purchases/actions";

export const metadata: Metadata = { title: "Purchase" };

export default async function PurchasePage({ params, searchParams }: PageProps<"/purchases/[id]">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let purchase: PurchaseDetailDto;
  let items: Map<string, VariantSummaryDto>;
  let returns: PurchaseReturnableDto["returns"];
  try {
    purchase = await getPurchase(who.ctx, { purchaseId: id });
    returns = (await getPurchaseReturnable(who.ctx, { purchaseId: id })).returns;
    items = await describeVariants(who.ctx, { variantIds: purchase.items.map((i) => i.variantId) });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    if (error instanceof PurchaseError) notFound();
    throw error;
  }
  const canVoid = purchase.status === "posted" && returns.length === 0 && who.permissions.includes("purchases.create") && who.permissions.includes("invoices.void");
  const canReturn = purchase.status === "posted" && who.permissions.includes("purchases.create");
  const showCost = purchase.items.some((i) => i.unitCostPaise !== undefined);
  return (
    <main className="flex max-w-4xl flex-col gap-4">
      <Link href="/purchases" className="text-sm underline">← Purchases</Link>
      {sp.saved === "1" && purchase.status === "posted" ? (
        <p role="status" className="rounded-lg border bg-muted/40 p-3 text-sm">
          Purchase saved. Check the totals below against the supplier&apos;s bill.
        </p>
      ) : null}
      <h1 className="text-2xl font-semibold tracking-tight">
        Bill {purchase.supplierInvoiceNumber}
        {purchase.status === "voided" ? <span className="text-base font-normal text-destructive"> (voided)</span> : null}
      </h1>
      <p className="text-sm">
        <Link href={`/suppliers/${purchase.supplierId}`} className="underline">{purchase.supplierName}</Link> · bill date {purchase.invoiceDate}
        {purchase.note === null ? "" : ` · ${purchase.note}`}
      </p>
      {purchase.status === "voided" ? (
        <p className="text-sm text-destructive">Voided: {purchase.voidReason}</p>
      ) : null}
      <table className="w-full rounded-lg border text-sm" aria-label="Bill lines">
        <thead className="border-b bg-muted/40 text-left">
          <tr>
            <th className="p-2 font-medium">#</th>
            <th className="p-2 font-medium">Item</th>
            <th className="p-2 text-right font-medium">Qty</th>
            <th className="p-2 text-right font-medium">Price before GST</th>
            <th className="p-2 text-right font-medium">GST</th>
            <th className="p-2 text-right font-medium">Line total</th>
            {showCost ? <th className="p-2 text-right font-medium">Cost per unit</th> : null}
          </tr>
        </thead>
        <tbody className="divide-y">
          {purchase.items.map((i) => {
            const item = items.get(i.variantId);
            return (
              <tr key={i.lineNumber}>
                <td className="p-2">{i.lineNumber}</td>
                <td className="p-2">
                  {item?.name ?? "Unknown item"} <span className="text-muted-foreground">{item?.sku ?? ""}</span>
                </td>
                <td className="p-2 text-right tabular-nums">{formatQuantity(i.quantity)} {item?.unitCode ?? ""}</td>
                <td className="p-2 text-right tabular-nums">{formatPaise(i.unitPricePaise)}</td>
                <td className="p-2 text-right tabular-nums">
                  {formatQuantity(i.taxRate)}% · {formatPaise(i.taxPaise)}
                </td>
                <td className="p-2 text-right tabular-nums">{formatPaise(i.totalPaise)}</td>
                {showCost ? <td className="p-2 text-right tabular-nums">{i.unitCostPaise === undefined ? "" : formatPaise(decimalPaiseToPaise(i.unitCostPaise))}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      <dl className="grid max-w-sm grid-cols-2 gap-1 text-sm" aria-label="Totals">
        <dt>Before GST</dt>
        <dd className="text-right tabular-nums">{formatPaise(purchase.subtotalPaise)}</dd>
        <dt>GST</dt>
        <dd className="text-right tabular-nums">{formatPaise(purchase.taxPaise)}</dd>
        <dt className="font-semibold">Bill total</dt>
        <dd className="text-right font-semibold tabular-nums">{formatPaise(purchase.totalPaise)}</dd>
        <dt>Paid with the bill</dt>
        <dd className="text-right tabular-nums">{formatPaise(purchase.paidPaise)}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        {purchase.costBasis === "excludes_tax" ? "Stock cost excludes GST (claimed back as input tax credit)." : "Stock cost includes the GST paid."}
      </p>
      {sp.returned === "1" ? (
        <p role="status" className="rounded-lg border bg-muted/40 p-3 text-sm">
          Goods sent back. The supplier&apos;s balance went down.
        </p>
      ) : null}
      {returns.length > 0 ? (
        <section className="flex flex-col gap-1 text-sm" aria-label="Returned to supplier">
          <h2 className="font-medium">Sent back to the supplier</h2>
          {returns.map((r) => (
            <p key={r.id}>
              {r.returnDate} · {formatPaise(r.totalPaise)} · {r.reason}
              {r.reference === null ? "" : ` · note ${r.reference}`}
            </p>
          ))}
        </section>
      ) : null}
      {canReturn ? (
        <Link href={`/purchases/${purchase.id}/return`} className="self-start text-sm underline">
          Return goods to the supplier
        </Link>
      ) : null}
      {canVoid ? <VoidPurchaseForm purchaseId={purchase.id} idempotencyKey={randomUUID()} save={voidPurchaseAction} /> : null}
    </main>
  );
}
