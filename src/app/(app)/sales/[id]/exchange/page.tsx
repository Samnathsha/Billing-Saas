import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { NotAllowed } from "@/components/not-allowed";
import { ExchangeScreen } from "@/components/pos/exchange-screen";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { getPosSetup, getReturnable, SalesError, type ReturnableDto } from "@/modules/sales";
import { listBranchChoices } from "@/modules/tenants";
import { priceItemsAction } from "@/app/(app)/pos/actions";
import { exchangeAction } from "@/app/(app)/sales/[id]/exchange/actions";

export const metadata: Metadata = { title: "Exchange" };

// Needs "Create sale"; past the return window, Manager and above (the
// service decides).
export default async function ExchangePage({ params }: PageProps<"/sales/[id]/exchange">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  if (!who.permissions.includes("sales.create")) return <NotAllowed />;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let bill: ReturnableDto;
  try {
    bill = await getReturnable(who.ctx, { invoiceId: id });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    if (error instanceof SalesError) notFound();
    throw error;
  }
  const setup = await getPosSetup(who.ctx);
  const branches = (await listBranchChoices(who.ctx)).filter((b) => b.open).map((b) => ({ id: b.id, name: b.name }));
  return (
    <main className="flex max-w-5xl flex-col gap-4">
      <Link href={`/sales/${bill.invoiceId}`} className="text-sm underline">← Bill {bill.number}</Link>
      <h1 className="text-2xl font-semibold tracking-tight">Exchange items from {bill.number}</h1>
      {bill.status === "voided" ? (
        <p className="text-sm text-destructive">This bill was voided; nothing can be exchanged.</p>
      ) : (
        <>
          {bill.daysSince > bill.windowDays ? (
            <p role="status" className="rounded-lg border border-destructive/40 p-3 text-sm">
              This bill is past the {bill.windowDays}-day return period. Only a manager or above can save this exchange.
            </p>
          ) : null}
          <ExchangeScreen bill={bill} setup={setup} branches={branches} actions={{ priceItems: priceItemsAction, exchange: exchangeAction }} />
        </>
      )}
    </main>
  );
}
