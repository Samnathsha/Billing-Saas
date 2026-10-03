import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ReturnForm } from "@/components/forms/return-form";
import { NotAllowed } from "@/components/not-allowed";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { getReturnable, SalesError, type ReturnableDto } from "@/modules/sales";
import { listBranchChoices } from "@/modules/tenants";
import { returnAction } from "@/app/(app)/sales/[id]/return/actions";

export const metadata: Metadata = { title: "Return items" };

// Needs "Create sale"; past the return window, Manager and above (the
// service decides).
export default async function ReturnPage({ params }: PageProps<"/sales/[id]/return">) {
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
  const branches = (await listBranchChoices(who.ctx)).filter((b) => b.open).map((b) => ({ id: b.id, name: b.name }));
  const late = bill.daysSince > bill.windowDays;
  return (
    <main className="flex max-w-4xl flex-col gap-4">
      <Link href={`/sales/${bill.invoiceId}`} className="text-sm underline">← Bill {bill.number}</Link>
      <h1 className="text-2xl font-semibold tracking-tight">Return items from {bill.number}</h1>
      <p className="text-sm">
        Bill date {bill.invoiceDate} ({bill.daysSince} day{bill.daysSince === 1 ? "" : "s"} ago){bill.buyerName === null ? "" : ` · ${bill.buyerName}`}
      </p>
      {bill.status === "voided" ? (
        <p className="text-sm text-destructive">This bill was voided; nothing can be returned.</p>
      ) : (
        <>
          {late ? (
            <p role="status" className="rounded-lg border border-destructive/40 p-3 text-sm">
              This bill is past the {bill.windowDays}-day return period. Only a manager or above can save this return; it will be marked as late.
            </p>
          ) : null}
          <ReturnForm bill={bill} branches={branches} creditNoteId={randomUUID()} idempotencyKey={randomUUID()} save={returnAction} />
        </>
      )}
    </main>
  );
}
