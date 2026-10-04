import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NotAllowed } from "@/components/not-allowed";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { listAuditLog, type AuditEntryDto } from "@/modules/reports";
import { todayInIndia } from "@/app/(app)/_shared/today";

export const metadata: Metadata = { title: "Audit log" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Who did what, newest first (Owner and Admin: "Business and tax settings").
// Read-only: the log itself can never be changed.
export default async function AuditLogPage({ searchParams }: PageProps<"/reports/audit">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  const sp = await searchParams;
  const today = todayInIndia();
  const from = typeof sp.from === "string" && DATE.test(sp.from) ? sp.from : today;
  const to = typeof sp.to === "string" && DATE.test(sp.to) ? sp.to : today;
  const action = typeof sp.action === "string" && /^[a-z_.]{0,60}$/.test(sp.action) ? sp.action : "";
  const page = typeof sp.page === "string" && /^\d{1,4}$/.test(sp.page) ? Math.max(1, Number(sp.page)) : 1;
  let result: { entries: AuditEntryDto[]; more: boolean };
  try {
    result = await listAuditLog(who.ctx, { from, to, action, page });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    throw error;
  }
  const at = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "medium" });
  const pageLink = (p: number) => `/reports/audit?from=${from}&to=${to}&action=${action}&page=${String(p)}`;
  return (
    <main className="flex max-w-5xl flex-col gap-4">
      <Link href="/reports" className="text-sm underline">← Reports</Link>
      <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          From
          <input type="date" name="from" defaultValue={from} className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          To
          <input type="date" name="to" defaultValue={to} className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          What (starts with, e.g. sales or purchases.voided)
          <input name="action" defaultValue={action} maxLength={60} className="h-8 w-64 rounded-lg border border-input bg-transparent px-2 text-sm" />
        </label>
        <button type="submit" className="h-8 rounded-lg border px-3 text-sm">Show</button>
      </form>
      {result.entries.length === 0 ? <p className="text-sm text-muted-foreground">Nothing recorded for these dates.</p> : null}
      <ul className="flex flex-col divide-y rounded-lg border text-sm" aria-label="Audit entries">
        {result.entries.map((e) => (
          <li key={e.id} className="flex flex-col gap-1 p-2">
            <p>
              <span className="tabular-nums text-muted-foreground">{at(e.occurredAt)}</span> · <strong>{e.actor}</strong>
              {e.actorRole === null ? "" : ` (${e.actorRole})`} · <code>{e.action}</code>
            </p>
            {e.before === null && e.after === null ? null : (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">Details</summary>
                {e.before === null ? null : <pre className="overflow-x-auto whitespace-pre-wrap text-xs">Before: {e.before}</pre>}
                {e.after === null ? null : <pre className="overflow-x-auto whitespace-pre-wrap text-xs">After: {e.after}</pre>}
              </details>
            )}
          </li>
        ))}
      </ul>
      <p className="flex gap-3 text-sm">
        {page > 1 ? <Link href={pageLink(page - 1)} className="underline">Newer</Link> : null}
        {result.more ? <Link href={pageLink(page + 1)} className="underline">Older</Link> : null}
      </p>
    </main>
  );
}
