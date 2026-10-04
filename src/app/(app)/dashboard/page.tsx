import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";
import { getRequestContext } from "@/modules/auth";
import { getDashboard } from "@/modules/reports";

export const metadata: Metadata = { title: "Dashboard" };

const METHODS: Record<string, string> = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank" };

// Today at a glance for "View reports"; everyone else gets their shortcuts.
export default async function DashboardPage() {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  const canSell = who.permissions.includes("sales.create");
  if (!who.permissions.includes("reports.view")) {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome</h1>
        <div className="flex flex-wrap gap-2">
          {canSell ? <Link href="/pos" className="rounded-lg border px-4 py-2 font-medium">New bill</Link> : null}
          <Link href="/sales" className="rounded-lg border px-4 py-2">Today&apos;s bills</Link>
          <Link href="/inventory" className="rounded-lg border px-4 py-2">Stock</Link>
        </div>
      </main>
    );
  }
  const d = await getDashboard(who.ctx);
  return (
    <main className="flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Today, {d.today}</h1>
        <div className="flex gap-2 text-sm">
          {canSell ? <Link href="/pos" className="rounded-lg border px-3 py-1 font-medium">New bill</Link> : null}
          <Link href="/reports" className="rounded-lg border px-3 py-1">Reports</Link>
        </div>
      </div>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Today">
        <div className="rounded-lg border p-3">
          <p className="text-sm text-muted-foreground">Net sales</p>
          <p className="text-2xl font-semibold tabular-nums">{formatPaise(d.sales.netSalesPaise)}</p>
          <p className="text-xs text-muted-foreground">
            {d.sales.bills} bill{d.sales.bills === 1 ? "" : "s"}
            {d.sales.returnsPaise > 0 ? ` · returns ${formatPaise(d.sales.returnsPaise)}` : ""}
          </p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-sm text-muted-foreground">Money in today</p>
          <p className="text-2xl font-semibold tabular-nums">{formatPaise(d.payments.totalReceivedPaise)}</p>
          <p className="text-xs text-muted-foreground">after refunds and expenses: {formatPaise(d.payments.netPaise)}</p>
        </div>
        <Link href="/reports?view=customer_ageing" className="rounded-lg border p-3 hover:bg-muted/40">
          <p className="text-sm text-muted-foreground">Customers owe you</p>
          <p className="text-2xl font-semibold tabular-nums">{formatPaise(d.receivablesPaise)}</p>
        </Link>
        <Link href="/reports?view=supplier_ageing" className="rounded-lg border p-3 hover:bg-muted/40">
          <p className="text-sm text-muted-foreground">You owe suppliers</p>
          <p className="text-2xl font-semibold tabular-nums">{formatPaise(d.payablesPaise)}</p>
        </Link>
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-2" aria-label="Payments by method">
          <h2 className="font-medium">Payments by method</h2>
          {d.payments.methods.length === 0 ? <p className="text-sm text-muted-foreground">No money in or out yet today.</p> : null}
          {d.payments.methods.map((m) => (
            <p key={m.method} className="flex justify-between text-sm">
              <span>{METHODS[m.method] ?? m.method}</span>
              <span className="tabular-nums">{formatPaise(m.netPaise)}</span>
            </p>
          ))}
        </section>
        <section className="flex flex-col gap-2" aria-label="Low stock">
          <h2 className="font-medium">Low stock</h2>
          {d.lowStock.length === 0 ? <p className="text-sm text-muted-foreground">Nothing at or below its reorder level.</p> : null}
          {d.lowStock.map((r) => (
            <p key={`${r.sku}-${r.branch}`} className="flex justify-between text-sm">
              <span>
                {r.name} <span className="text-muted-foreground">({r.branch})</span>
              </span>
              <span className="tabular-nums">
                {formatQuantity(r.quantity)} / {formatQuantity(r.reorderLevel)}
              </span>
            </p>
          ))}
          {d.lowStock.length > 0 ? <Link href="/reports?view=low_stock" className="text-sm underline">All low stock</Link> : null}
        </section>
      </div>
    </main>
  );
}
