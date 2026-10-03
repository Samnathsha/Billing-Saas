import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NewPurchaseForm } from "@/components/forms/purchase-forms";
import { NotAllowed } from "@/components/not-allowed";
import { getRequestContext } from "@/modules/auth";
import { listSuppliers } from "@/modules/parties";
import { listBranchChoices } from "@/modules/tenants";
import { todayInIndia } from "@/app/(app)/_shared/today";
import { createPurchaseAction } from "@/app/(app)/purchases/actions";

export const metadata: Metadata = { title: "New purchase" };

// Needs "Create purchase" (the service checks it again on save).
export default async function NewPurchasePage({ searchParams }: PageProps<"/purchases/new">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  if (!who.permissions.includes("purchases.create")) return <NotAllowed />;
  const sp = await searchParams;
  const suppliers = await listSuppliers(who.ctx);
  const branches = (await listBranchChoices(who.ctx)).filter((b) => b.open);
  const preselected = typeof sp.supplier === "string" && suppliers.some((s) => s.id === sp.supplier) ? sp.supplier : "";
  return (
    <main className="flex max-w-4xl flex-col gap-4">
      <Link href="/purchases" className="text-sm underline">← Purchases</Link>
      <h1 className="text-2xl font-semibold tracking-tight">New purchase</h1>
      {suppliers.length === 0 ? (
        <p className="text-sm">
          Add a supplier first on the <Link href="/suppliers" className="underline">Suppliers</Link> page.
        </p>
      ) : (
        <NewPurchaseForm
          suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
          supplierId={preselected}
          branches={branches.map((b) => ({ id: b.id, name: b.name }))}
          idempotencyKey={randomUUID()}
          today={todayInIndia()}
          costNote="Enter the prices exactly as on the supplier's bill, before GST. After saving, check the totals against the bill; a wrong bill is voided and entered again."
          save={createPurchaseAction}
        />
      )}
    </main>
  );
}
