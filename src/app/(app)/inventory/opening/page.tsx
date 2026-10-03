import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { OpeningStockForm } from "@/components/forms/stock-forms";
import { NotAllowed } from "@/components/not-allowed";
import { getRequestContext } from "@/modules/auth";
import { listBranchChoices } from "@/modules/tenants";
import { openingStockAction } from "@/app/(app)/inventory/actions";

export const metadata: Metadata = { title: "Opening stock" };

// Needs "Stock adjustment" (the service checks it again on save).
export default async function Page() {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  if (!who.permissions.includes("stock.adjust")) return <NotAllowed />;
  const branches = (await listBranchChoices(who.ctx)).filter((b) => b.open);
  return (
    <main className="flex max-w-3xl flex-col gap-4">
      <Link href="/inventory" className="text-sm underline">← Stock</Link>
      <h1 className="text-2xl font-semibold tracking-tight">Opening stock</h1>
      <p className="text-sm text-muted-foreground">What is on your shelves on the day you start. Once per item and branch; later changes are adjustments. Leave the cost empty to use the product&apos;s cost.</p>
      <OpeningStockForm branches={branches.map((b) => ({ id: b.id, name: b.name }))} idempotencyKey={randomUUID()} showCost={who.permissions.includes("costs.view")} save={openingStockAction} />
    </main>
  );
}
