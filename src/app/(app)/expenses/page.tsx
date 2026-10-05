import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { RecordExpenseForm, SimpleActionForm } from "@/components/forms/expense-forms";
import { NotAllowed } from "@/components/not-allowed";
import { formatPaise } from "@/lib/money";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { listExpenseCategories, listExpenses, type ExpenseCategoryDto, type ExpenseDto } from "@/modules/expenses";
import { listBranchChoices } from "@/modules/tenants";
import { todayInIndia } from "@/app/(app)/_shared/today";
import { addCategoryAction, addUsualCategoriesAction, recordExpenseAction, voidExpenseAction } from "@/app/(app)/expenses/actions";

export const metadata: Metadata = { title: "Expenses" };

const METHODS: Record<string, string> = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Expenses of a date range (this month by default). "Record expenses" to
// add or void; "View reports" to look.
export default async function ExpensesPage({ searchParams }: PageProps<"/expenses">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  const sp = await searchParams;
  const today = todayInIndia();
  const from = typeof sp.from === "string" && DATE.test(sp.from) ? sp.from : `${today.slice(0, 8)}01`;
  const to = typeof sp.to === "string" && DATE.test(sp.to) ? sp.to : today;
  let categories: ExpenseCategoryDto[];
  let rows: ExpenseDto[];
  try {
    categories = await listExpenseCategories(who.ctx);
    rows = from <= to ? await listExpenses(who.ctx, { from, to }) : [];
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    throw error;
  }
  const canRecord = who.permissions.includes("expenses.manage");
  const posted = rows.filter((r) => r.status === "posted");
  const byCategory = new Map<string, number>();
  for (const r of posted) byCategory.set(r.categoryName, (byCategory.get(r.categoryName) ?? 0) + r.amountPaise);
  const total = posted.reduce((s, r) => s + r.amountPaise, 0);
  const branches = canRecord ? (await listBranchChoices(who.ctx)).filter((b) => b.open).map((b) => ({ id: b.id, name: b.name })) : [];
  const active = categories.filter((c) => c.active);
  return (
    <main className="flex max-w-4xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>
      <form method="get" className="flex flex-wrap items-end gap-2">
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
      <section className="flex flex-col gap-1 text-sm" aria-label="Expense totals">
        <p className="font-medium">
          Total {from} to {to}: {formatPaise(total)}
        </p>
        {[...byCategory].map(([name, paise]) => (
          <p key={name}>
            {name}: {formatPaise(paise)}
          </p>
        ))}
      </section>

      {canRecord && active.length === 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
          <p>No expense categories yet.</p>
          <SimpleActionForm label="Add the usual categories (rent, salaries, electricity…)" fields={{}} save={addUsualCategoriesAction} />
        </div>
      ) : null}
      {canRecord && active.length > 0 ? (
        <RecordExpenseForm categories={active.map((c) => ({ id: c.id, name: c.name }))} branches={branches} idempotencyKey={randomUUID()} today={today} save={recordExpenseAction} />
      ) : null}

      {rows.length === 0 ? <p className="text-sm text-muted-foreground">No expenses in these dates.</p> : null}
      {rows.length > 0 ? (
        <div className="table-scroll"><table className="w-full text-sm" aria-label="Expenses">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-2 font-medium">Date</th>
              <th className="p-2 font-medium">Category</th>
              <th className="p-2 font-medium">What for</th>
              <th className="p-2 font-medium">Paid by</th>
              <th className="p-2 text-right font-medium">Amount</th>
              {canRecord ? <th className="p-2" /> : null}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.id} aria-label={r.description} className={r.status === "voided" ? "text-muted-foreground line-through" : undefined}>
                <td className="p-2">{r.paidOn}</td>
                <td className="p-2">{r.categoryName}</td>
                <td className="p-2">
                  {r.description}
                  {r.reference === null ? "" : ` · ${r.reference}`}
                  {r.status === "voided" ? <span className="block no-underline">Voided: {r.voidReason}</span> : null}
                </td>
                <td className="p-2">{METHODS[r.method] ?? r.method}</td>
                <td className="p-2 text-right tabular-nums">{formatPaise(r.amountPaise)}</td>
                {canRecord ? (
                  <td className="p-2">
                    {r.status === "posted" ? (
                      <SimpleActionForm label="Void" variant="destructive" fields={{ expenseId: r.id, idempotencyKey: randomUUID() }} input={{ name: "reason", label: `Reason to void ${r.description}`, required: true }} save={voidExpenseAction} />
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : null}

      {canRecord ? (
        <section className="flex flex-col gap-2 text-sm" aria-label="Categories">
          <h2 className="font-medium">Categories</h2>
          <p>{categories.map((c) => `${c.name}${c.active ? "" : " (archived)"}`).join(", ") || "None yet."}</p>
          <SimpleActionForm label="Add category" fields={{}} input={{ name: "name", label: "New category name", required: true }} save={addCategoryAction} />
        </section>
      ) : null}
    </main>
  );
}
