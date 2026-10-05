import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArchiveCustomerForm, CustomerPaymentForm, EditCustomerForm } from "@/components/forms/customer-forms";
import { NotAllowed } from "@/components/not-allowed";
import { formatPaise, paiseToRupeesText } from "@/lib/money";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { getCustomer, PartyError, type CustomerDto } from "@/modules/parties";
import { listCustomerPayments, listInvoices, type CustomerPaymentDto, type InvoiceListItemDto } from "@/modules/sales";
import { listBranchChoices } from "@/modules/tenants";
import { GST_STATES } from "@/modules/tax";
import { archiveCustomerAction, customerPaymentAction, editCustomerAction } from "@/app/(app)/customers/actions";

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerPage({ params }: PageProps<"/customers/[id]">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let customer: CustomerDto;
  let bills: InvoiceListItemDto[];
  let payments: CustomerPaymentDto[];
  try {
    customer = await getCustomer(who.ctx, { id });
    bills = await listInvoices(who.ctx, { customerId: id });
    payments = await listCustomerPayments(who.ctx, { customerId: id });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    if (error instanceof PartyError) notFound();
    throw error;
  }
  const canGiveCredit = who.permissions.includes("discounts.above_limit");
  const left = customer.creditLimitPaise - customer.balancePaise;
  return (
    <main className="flex max-w-4xl flex-col gap-4">
      <Link href="/customers" className="text-sm underline">← Customers</Link>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {customer.name}
          {customer.active ? "" : <span className="text-base font-normal text-muted-foreground"> (archived)</span>}
        </h1>
        <p className="text-lg tabular-nums" aria-label="Balance">
          {customer.balancePaise === 0 ? "Owes nothing" : customer.balancePaise > 0 ? `Owes ${formatPaise(customer.balancePaise)}` : `Advance ${formatPaise(-customer.balancePaise)}`}
        </p>
      </div>
      <p className="text-sm" aria-label="Credit">
        {customer.creditLimitPaise === 0 ? "No credit allowed." : `Credit limit ${formatPaise(customer.creditLimitPaise)}; ${formatPaise(Math.max(0, left))} left.`}
      </p>
      {who.permissions.includes("sales.create") ? (
        <CustomerPaymentForm
          customerId={customer.id}
          branches={(await listBranchChoices(who.ctx)).filter((b) => b.open).map((b) => ({ id: b.id, name: b.name }))}
          idempotencyKey={randomUUID()}
          owesPaise={customer.balancePaise}
          save={customerPaymentAction}
        />
      ) : null}
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Payments</h2>
        {payments.length === 0 ? <p className="text-sm text-muted-foreground">No payments yet.</p> : null}
        {payments.length > 0 ? (
          <div className="table-scroll"><table className="w-full text-sm" aria-label="Customer payments">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-2 font-medium">Date</th>
                <th className="p-2 font-medium">Method</th>
                <th className="p-2 font-medium">Reference</th>
                <th className="p-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="p-2">{p.receivedOn}</td>
                  <td className="p-2">{p.method === "upi" ? "UPI" : p.method === "card" ? "Card" : "Cash"}</td>
                  <td className="p-2">{p.reference ?? ""}</td>
                  <td className="p-2 text-right tabular-nums">{formatPaise(p.amountPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ) : null}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Bills</h2>
        {bills.length === 0 ? <p className="text-sm text-muted-foreground">No bills yet.</p> : null}
        {bills.length > 0 ? (
          <div className="table-scroll"><table className="w-full text-sm" aria-label="Customer bills">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-2 font-medium">Bill</th>
                <th className="p-2 font-medium">Date</th>
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
                  <td className="p-2">{b.invoiceDate}</td>
                  <td className="p-2 text-right tabular-nums">{formatPaise(b.payablePaise)}</td>
                  <td className="p-2 text-right tabular-nums">{b.creditPaise > 0 ? formatPaise(b.creditPaise) : ""}</td>
                  <td className="p-2">{b.status === "voided" ? "Voided" : "Posted"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ) : null}
      </section>
      {who.permissions.includes("sales.create") ? (
        <EditCustomerForm
          key={customer.version}
          states={[...GST_STATES].map(([code, name]) => ({ code, name }))}
          canGiveCredit={canGiveCredit}
          customer={{ ...customer, creditLimit: paiseToRupeesText(customer.creditLimitPaise) }}
          save={editCustomerAction}
        />
      ) : null}
      {canGiveCredit ? <ArchiveCustomerForm id={customer.id} active={customer.active} save={archiveCustomerAction} /> : null}
    </main>
  );
}
