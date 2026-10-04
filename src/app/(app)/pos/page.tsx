import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NotAllowed } from "@/components/not-allowed";
import { TillMode } from "@/components/till/till-mode";
import { getRequestContext } from "@/modules/auth";
import { getPosSetup } from "@/modules/sales";
import { listBranchChoices } from "@/modules/tenants";
import { addCustomerAction, findCustomersAction, priceItemsAction, saleAction, searchItemsAction } from "@/app/(app)/pos/actions";

export const metadata: Metadata = { title: "Billing" };

// The till. Needs "Create sale" (every action checks it again).
export default async function PosPage() {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  if (!who.permissions.includes("sales.create")) return <NotAllowed />;
  const setup = await getPosSetup(who.ctx);
  const branches = (await listBranchChoices(who.ctx)).filter((b) => b.open).map((b) => ({ id: b.id, name: b.name }));
  return (
    <main className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">New bill</h1>
        <Link href="/sales" className="text-sm underline">Today&apos;s bills</Link>
      </div>
      <TillMode
        setup={setup}
        branches={branches}
        actions={{ priceItems: priceItemsAction, searchItems: searchItemsAction, findCustomers: findCustomersAction, addCustomer: addCustomerAction, sale: saleAction }}
      />
    </main>
  );
}
