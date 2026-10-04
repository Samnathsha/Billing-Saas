import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { NotAllowed } from "@/components/not-allowed";
import { formatPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import {
  getAgeing,
  getLowStock,
  getPaymentsReport,
  getProfitReport,
  getSalesBreakdown,
  getSalesReport,
  getStockValue,
  getTaxSummary,
} from "@/modules/reports";
import { todayInIndia } from "@/app/(app)/_shared/today";

export const metadata: Metadata = { title: "Reports" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const METHODS: Record<string, string> = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank" };

// Which reports exist, what each needs, and whether it uses dates.
const VIEWS = [
  { id: "sales", label: "Sales by day", dated: true, cost: false },
  { id: "by_item", label: "By item", dated: true, cost: false },
  { id: "by_category", label: "By category", dated: true, cost: false },
  { id: "by_user", label: "By staff member", dated: true, cost: false },
  { id: "payments", label: "Money in and out", dated: true, cost: false },
  { id: "profit", label: "Profit", dated: true, cost: true },
  { id: "stock", label: "Stock value", dated: false, cost: true },
  { id: "low_stock", label: "Low stock", dated: false, cost: false },
  { id: "customer_ageing", label: "Customers owe", dated: false, cost: false },
  { id: "supplier_ageing", label: "We owe suppliers", dated: false, cost: false },
  { id: "tax", label: "GST summary", dated: true, cost: false },
] as const;

const th = "p-2 font-medium";
const thr = "p-2 text-right font-medium";
const td = "p-2";
const tdr = "p-2 text-right tabular-nums";

function Table(props: { label: string; head: ReactNode; children: ReactNode; foot?: ReactNode }): ReactNode {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm" aria-label={props.label}>
        <thead className="border-b bg-muted/40 text-left">{props.head}</thead>
        <tbody className="divide-y">{props.children}</tbody>
        {props.foot === undefined ? null : <tfoot className="border-t font-medium">{props.foot}</tfoot>}
      </table>
    </div>
  );
}

// Reports (blueprint Phase 9): "View reports"; profit and stock value also
// "View cost price and profit". Every service checks again.
export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  if (!who.permissions.includes("reports.view")) return <NotAllowed />;
  const showCost = who.permissions.includes("costs.view");
  const sp = await searchParams;
  const today = todayInIndia();
  const from = typeof sp.from === "string" && DATE.test(sp.from) ? sp.from : `${today.slice(0, 8)}01`;
  const to = typeof sp.to === "string" && DATE.test(sp.to) ? sp.to : today;
  const views = VIEWS.filter((v) => !v.cost || showCost);
  const view = views.find((v) => v.id === sp.view) ?? views[0];
  if (view === undefined) return <NotAllowed />;
  const range = { from, to };
  const link = (id: string) => `/reports?view=${id}&from=${from}&to=${to}`;
  const csv = `/api/reports/csv?report=${view.id}${view.dated ? `&from=${from}&to=${to}` : ""}`;

  let body: ReactNode;
  try {
    body = await renderView(view.id, range, who.ctx);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    if (error instanceof Error && error.name === "ZodError") body = <p className="text-sm text-destructive">Please check the dates (at most one year, start before end).</p>;
    else throw error;
  }

  return (
    <main className="flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        {who.permissions.includes("settings.manage") ? <Link href="/reports/audit" className="text-sm underline">Audit log</Link> : null}
      </div>
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Report">
        {views.map((v) => (
          <Link key={v.id} href={link(v.id)} aria-current={v.id === view.id ? "page" : undefined} className={v.id === view.id ? "rounded-lg border bg-muted px-2 py-1 font-medium" : "rounded-lg border px-2 py-1"}>
            {v.label}
          </Link>
        ))}
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-2">
        {view.dated ? (
          <form method="get" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="view" value={view.id} />
            <label className="flex flex-col gap-1 text-sm">
              From
              <input type="date" name="from" defaultValue={from} className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              To
              <input type="date" name="to" defaultValue={to} className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm" />
            </label>
            <button type="submit" className="h-8 rounded-lg border px-3 text-sm">Show</button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">As of now.</p>
        )}
        <a href={csv} className="text-sm underline" download>
          Download CSV
        </a>
      </div>
      {body}
    </main>
  );
}

async function renderView(id: (typeof VIEWS)[number]["id"], range: { from: string; to: string }, ctx: Parameters<typeof getSalesReport>[0]): Promise<ReactNode> {
  switch (id) {
    case "sales": {
      const r = await getSalesReport(ctx, range);
      return (
        <>
          <dl className="grid max-w-md grid-cols-2 gap-1 text-sm" aria-label="Sales totals">
            <dt>Bills</dt>
            <dd className={tdr}>{r.bills}{r.voided > 0 ? ` (+${String(r.voided)} voided)` : ""}</dd>
            <dt>Sales</dt>
            <dd className={tdr}>{formatPaise(r.salesPaise)}</dd>
            <dt>Returns ({r.creditNotes} credit notes)</dt>
            <dd className={tdr}>−{formatPaise(r.returnsPaise)}</dd>
            <dt className="font-semibold">Net sales</dt>
            <dd className={`${tdr} font-semibold`}>{formatPaise(r.netSalesPaise)}</dd>
            <dt>of which GST</dt>
            <dd className={tdr}>{formatPaise(r.taxPaise)}</dd>
            <dt>Discounts given</dt>
            <dd className={tdr}>{formatPaise(r.discountPaise)}</dd>
            <dt>Sold on credit</dt>
            <dd className={tdr}>{formatPaise(r.onCreditPaise)}</dd>
          </dl>
          <Table label="Sales by day" head={<tr><th className={th}>Day</th><th className={thr}>Bills</th><th className={thr}>Sales</th><th className={thr}>Returns</th><th className={thr}>Net</th></tr>}>
            {r.days.map((d) => (
              <tr key={d.day}>
                <td className={td}>{d.day}</td>
                <td className={tdr}>{d.bills}</td>
                <td className={tdr}>{formatPaise(d.salesPaise)}</td>
                <td className={tdr}>{formatPaise(d.returnsPaise)}</td>
                <td className={tdr}>{formatPaise(d.netPaise)}</td>
              </tr>
            ))}
          </Table>
        </>
      );
    }
    case "by_item":
    case "by_category":
    case "by_user": {
      const by = id === "by_item" ? "item" : id === "by_category" ? "category" : "user";
      const rows = await getSalesBreakdown(ctx, { ...range, by });
      return (
        <>
          <p className="text-xs text-muted-foreground">Line amounts with GST, before each bill&apos;s round-off; returns in the same dates.</p>
          <Table
            label="Sales breakdown"
            head={
              <tr>
                <th className={th}>{by === "item" ? "Item" : by === "category" ? "Category" : "Staff member"}</th>
                <th className={thr}>Bills</th>
                <th className={thr}>Sold</th>
                <th className={thr}>Returned</th>
                <th className={thr}>Sales</th>
                <th className={thr}>Returns</th>
                <th className={thr}>Net</th>
              </tr>
            }
          >
            {rows.map((r) => (
              <tr key={r.key}>
                <td className={td}>
                  {r.name}
                  {r.sku === "" ? null : <span className="block text-xs text-muted-foreground">{r.sku}</span>}
                </td>
                <td className={tdr}>{r.bills}</td>
                <td className={tdr}>{formatQuantity(r.quantitySold)}</td>
                <td className={tdr}>{formatQuantity(r.quantityReturned)}</td>
                <td className={tdr}>{formatPaise(r.salesPaise)}</td>
                <td className={tdr}>{formatPaise(r.returnsPaise)}</td>
                <td className={tdr}>{formatPaise(r.netPaise)}</td>
              </tr>
            ))}
          </Table>
        </>
      );
    }
    case "payments": {
      const r = await getPaymentsReport(ctx, range);
      return (
        <Table
          label="Money in and out"
          head={<tr><th className={th}>Method</th><th className={thr}>Received</th><th className={thr}>Refunded</th><th className={thr}>Expenses</th><th className={thr}>Net</th></tr>}
          foot={<tr><td className={td}>Total</td><td className={tdr}>{formatPaise(r.totalReceivedPaise)}</td><td className={tdr}>{formatPaise(r.totalRefundedPaise)}</td><td className={tdr}>{formatPaise(r.totalExpensesPaise)}</td><td className={tdr}>{formatPaise(r.netPaise)}</td></tr>}
        >
          {r.methods.map((m) => (
            <tr key={m.method}>
              <td className={td}>{METHODS[m.method] ?? m.method}</td>
              <td className={tdr}>{formatPaise(m.receivedPaise)}</td>
              <td className={tdr}>{formatPaise(m.refundedPaise)}</td>
              <td className={tdr}>{formatPaise(m.expensesPaise)}</td>
              <td className={tdr}>{formatPaise(m.netPaise)}</td>
            </tr>
          ))}
        </Table>
      );
    }
    case "profit": {
      const p = await getProfitReport(ctx, range);
      return (
        <dl className="grid max-w-md grid-cols-2 gap-1 text-sm" aria-label="Profit">
          <dt>Sales without GST</dt>
          <dd className={tdr}>{formatPaise(p.salesTaxablePaise)}</dd>
          <dt>Returns without GST</dt>
          <dd className={tdr}>−{formatPaise(p.returnsTaxablePaise)}</dd>
          <dt>Net sales</dt>
          <dd className={tdr}>{formatPaise(p.netSalesPaise)}</dd>
          <dt>Cost of goods sold</dt>
          <dd className={tdr}>−{formatPaise(p.costOfGoodsPaise)}</dd>
          <dt className="font-semibold">Gross profit</dt>
          <dd className={`${tdr} font-semibold`}>{formatPaise(p.grossProfitPaise)}</dd>
          <dt>Expenses</dt>
          <dd className={tdr}>−{formatPaise(p.expensesPaise)}</dd>
          <dt className="font-semibold">Net profit</dt>
          <dd className={`${tdr} font-semibold`}>{formatPaise(p.netProfitPaise)}</dd>
        </dl>
      );
    }
    case "stock": {
      const s = await getStockValue(ctx);
      return (
        <Table label="Stock value" head={<tr><th className={th}>Branch</th><th className={thr}>Quantity</th><th className={thr}>Value at average cost</th></tr>} foot={<tr><td className={td}>Total</td><td /><td className={tdr}>{formatPaise(s.totalPaise)}</td></tr>}>
          {s.branches.map((b) => (
            <tr key={b.branchId}>
              <td className={td}>{b.branch}</td>
              <td className={tdr}>{formatQuantity(b.quantity)}</td>
              <td className={tdr}>{formatPaise(b.valuePaise)}</td>
            </tr>
          ))}
        </Table>
      );
    }
    case "low_stock": {
      const rows = await getLowStock(ctx);
      return rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is at or below its reorder level (set a reorder level on a product&apos;s variant to watch it).</p>
      ) : (
        <Table label="Low stock" head={<tr><th className={th}>Item</th><th className={th}>Branch</th><th className={thr}>In stock</th><th className={thr}>Reorder level</th></tr>}>
          {rows.map((r) => (
            <tr key={`${r.sku}-${r.branch}`}>
              <td className={td}>
                {r.name} <span className="text-xs text-muted-foreground">{r.sku}</span>
              </td>
              <td className={td}>{r.branch}</td>
              <td className={tdr}>{formatQuantity(r.quantity)}</td>
              <td className={tdr}>{formatQuantity(r.reorderLevel)}</td>
            </tr>
          ))}
        </Table>
      );
    }
    case "customer_ageing":
    case "supplier_ageing": {
      const party = id === "customer_ageing" ? "customer" : "supplier";
      const rows = await getAgeing(ctx, { party });
      return (
        <>
          <p className="text-xs text-muted-foreground">How long amounts have been owed; payments count against the oldest first. A negative balance is an advance.</p>
          <Table
            label={party === "customer" ? "Customers owe" : "We owe suppliers"}
            head={<tr><th className={th}>{party === "customer" ? "Customer" : "Supplier"}</th><th className={thr}>Balance</th><th className={thr}>0–30 days</th><th className={thr}>31–60</th><th className={thr}>61–90</th><th className={thr}>Over 90</th></tr>}
          >
            {rows.map((r) => (
              <tr key={r.partyId}>
                <td className={td}>
                  <Link href={`/${party === "customer" ? "customers" : "suppliers"}/${r.partyId}`} className="underline">{r.name}</Link>
                </td>
                <td className={tdr}>{formatPaise(r.balancePaise)}</td>
                <td className={tdr}>{formatPaise(r.days0to30Paise)}</td>
                <td className={tdr}>{formatPaise(r.days31to60Paise)}</td>
                <td className={tdr}>{formatPaise(r.days61to90Paise)}</td>
                <td className={tdr}>{formatPaise(r.over90Paise)}</td>
              </tr>
            ))}
          </Table>
        </>
      );
    }
    case "tax": {
      const t = await getTaxSummary(ctx, range);
      return (
        <>
          <p role="note" className="rounded-lg border border-amber-400/60 bg-amber-50 p-2 text-sm dark:bg-amber-950/30">
            GST summary for checking only: validate with your accountant before filing. Until real rates are set, the rates are TEST rates.
          </p>
          <Table label="Output GST" head={<tr><th className={th}>Sales at rate</th><th className={thr}>Taxable</th><th className={thr}>CGST</th><th className={thr}>SGST</th><th className={thr}>IGST</th></tr>}>
            {t.output.map((r) => (
              <tr key={r.rate}>
                <td className={td}>{formatQuantity(r.rate)}%</td>
                <td className={tdr}>{formatPaise(r.taxablePaise)}</td>
                <td className={tdr}>{formatPaise(r.cgstPaise)}</td>
                <td className={tdr}>{formatPaise(r.sgstPaise)}</td>
                <td className={tdr}>{formatPaise(r.igstPaise)}</td>
              </tr>
            ))}
          </Table>
          <Table label="Input GST" head={<tr><th className={th}>Purchases at rate</th><th className={thr}>Taxable</th><th className={thr}>GST paid</th></tr>}>
            {t.input.map((r) => (
              <tr key={r.rate}>
                <td className={td}>{formatQuantity(r.rate)}%</td>
                <td className={tdr}>{formatPaise(r.taxablePaise)}</td>
                <td className={tdr}>{formatPaise(r.taxPaise)}</td>
              </tr>
            ))}
          </Table>
          <dl className="grid max-w-sm grid-cols-2 gap-1 text-sm" aria-label="GST totals">
            <dt>GST on sales</dt>
            <dd className={tdr}>{formatPaise(t.outputTaxPaise)}</dd>
            <dt>GST on purchases</dt>
            <dd className={tdr}>{formatPaise(t.inputTaxPaise)}</dd>
          </dl>
        </>
      );
    }
  }
}
