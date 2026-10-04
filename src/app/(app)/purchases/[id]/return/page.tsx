import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PurchaseReturnForm } from "@/components/forms/purchase-forms";
import { NotAllowed } from "@/components/not-allowed";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { describeVariants } from "@/modules/catalog";
import { getPurchaseReturnable, PurchaseError, type PurchaseReturnableDto } from "@/modules/purchasing";
import { purchaseReturnAction } from "@/app/(app)/purchases/actions";

export const metadata: Metadata = { title: "Return to supplier" };

// Needs "Create purchase" (the service checks it again).
export default async function PurchaseReturnPage({ params }: PageProps<"/purchases/[id]/return">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  if (!who.permissions.includes("purchases.create")) return <NotAllowed />;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let data: PurchaseReturnableDto;
  try {
    data = await getPurchaseReturnable(who.ctx, { purchaseId: id });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    if (error instanceof PurchaseError) notFound();
    throw error;
  }
  const names = await describeVariants(who.ctx, { variantIds: data.lines.map((l) => l.variantId) });
  const open = data.lines.filter((l) => l.remaining !== "0.000");
  return (
    <main className="flex max-w-3xl flex-col gap-4">
      <Link href={`/purchases/${id}`} className="text-sm underline">← Bill {data.supplierInvoiceNumber}</Link>
      <h1 className="text-2xl font-semibold tracking-tight">Send goods back to the supplier</h1>
      <p className="text-sm text-muted-foreground">
        What you owe the supplier goes down by the value of these lines (with their GST). The goods leave stock now.
      </p>
      {data.status === "voided" ? <p className="text-sm text-destructive">This purchase was voided.</p> : null}
      {data.status === "posted" && open.length === 0 ? <p className="text-sm">Everything on this bill has already gone back.</p> : null}
      {data.status === "posted" && open.length > 0 ? (
        <PurchaseReturnForm
          purchaseId={id}
          idempotencyKey={randomUUID()}
          lines={open.map((l) => ({ purchaseItemId: l.purchaseItemId, name: names.get(l.variantId)?.name ?? "Item", remaining: l.remaining, serialsInStock: l.serialsInStock }))}
          save={purchaseReturnAction}
        />
      ) : null}
    </main>
  );
}
