import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdjustStockForm } from "@/components/forms/stock-forms";
import { NotAllowed } from "@/components/not-allowed";
import { getRequestContext } from "@/modules/auth";
import { listBranchChoices } from "@/modules/tenants";
import { adjustStockAction } from "@/app/(app)/inventory/actions";

export const metadata: Metadata = { title: "Adjust stock" };

// Needs "Stock adjustment" (the service checks it again on save).
export default async function Page() {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  if (!who.permissions.includes("stock.adjust")) return <NotAllowed />;
  const branches = (await listBranchChoices(who.ctx)).filter((b) => b.open);
  return (
    <main className="flex max-w-3xl flex-col gap-4">
      <Link href="/inventory" className="text-sm underline">← Stock</Link>
      <h1 className="text-2xl font-semibold tracking-tight">Adjust stock</h1>
      <p className="text-sm text-muted-foreground">Damaged, lost, expired or found stock, and count corrections. Every adjustment needs a reason and is recorded with your name.</p>
      <AdjustStockForm branches={branches.map((b) => ({ id: b.id, name: b.name }))} idempotencyKey={randomUUID()} save={adjustStockAction} />
    </main>
  );
}
