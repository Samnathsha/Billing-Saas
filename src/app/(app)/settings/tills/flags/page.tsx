import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NotAllowed } from "@/components/not-allowed";
import { ResolveFlagForm } from "@/components/forms/till-forms";
import { formatPaise } from "@/lib/money";
import { getRequestContext } from "@/modules/auth";
import { listSyncFlags, type SyncFlagDto } from "@/modules/sync";
import { resolveFlagAction } from "@/app/(app)/settings/tills/actions";

export const metadata: Metadata = { title: "Offline bills to check" };

// Offline bills and returns that were kept but no longer fitted when they
// reached the server (business rules 17), for a manager to check and mark
// as reviewed with a note.

const money = (value: string | number | null | undefined): string => (typeof value === "number" ? formatPaise(value) : "–");
const text = (value: string | number | null | undefined): string => (value === null || value === undefined ? "–" : String(value));

function describe(f: SyncFlagDto): string {
  const d = f.detail;
  switch (f.code) {
    case "stock_short":
      return `Stock went below zero: ${text(d.item)}. Count the shelf and correct the stock, or record the purchase.`;
    case "price_changed":
      return `${text(d.item)} was sold at ${money(d.paidPaise)}; the price is now ${money(d.nowPaise)}.`;
    case "tax_changed":
      return `${text(d.item)}: GST charged ${text(d.chargedRate)}%, the rate now is ${d.nowRate === null ? "not set" : `${text(d.nowRate)}%`}. Check with the accountant.`;
    case "settings_changed":
      return "The till still used the old setting for prices with or without GST.";
    case "discount_over_limit":
      return `Discount of ${money(d.discountPaise)} is above the seller's limit.`;
    case "item_archived":
      return `${text(d.item)} was archived but still sold on the till.`;
    case "imei_unavailable":
      return `IMEI ${text(d.imei)} (${text(d.item)}) was already sold or not in stock here. Find out which phone really left.`;
    case "role_removed":
      return "The seller may no longer sell (role changed or removed).";
    case "date_corrected":
      return `The till's clock said ${text(d.tillDay)}; the bill was dated ${text(d.usedDay)}.`;
    case "number_gap":
      return `Till numbers skipped: expected ${text(d.expected)}, got ${text(d.got)}. A bill may be missing on that till.`;
    case "return_after_window":
      return `Returned after the return period (bill ${text(d.billDay)}, return ${text(d.returnDay)}).`;
    case "refund_differs":
      return `The till refunded ${money(d.paidPaise)}; the server works out ${money(d.nowPaise)}.`;
  }
}

export default async function FlagsPage() {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  if (!who.permissions.includes("tills.manage")) return <NotAllowed />;
  const [open, reviewed] = await Promise.all([listSyncFlags(who.ctx, { status: "open" }), listSyncFlags(who.ctx, { status: "resolved" })]);
  const docLink = (f: SyncFlagDto) =>
    f.document === null ? "–" : <Link href={f.document.kind === "invoice" ? `/sales/${f.document.id}` : `/credit-notes/${f.document.id}`} className="underline">{f.document.number}</Link>;
  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Offline bills to check</h1>
      <section aria-label="To check" className="flex flex-col gap-2">
        {open.length === 0 ? <p className="text-sm text-muted-foreground">Nothing to check.</p> : null}
        <ul className="flex flex-col divide-y rounded-lg border">
          {open.map((f) => (
            <li key={f.id} className="flex flex-col gap-2 p-3 text-sm" aria-label={f.code}>
              <span>
                {docLink(f)} · {f.tillName} · {new Date(f.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
              </span>
              <span>{describe(f)}</span>
              <ResolveFlagForm flagId={f.id} resolve={resolveFlagAction} />
            </li>
          ))}
        </ul>
      </section>
      {reviewed.length > 0 ? (
        <section aria-label="Reviewed" className="flex flex-col gap-2">
          <h2 className="font-medium">Reviewed</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {reviewed.slice(0, 50).map((f) => (
              <li key={f.id}>
                {docLink(f)} · {describe(f)} · <em>{f.resolutionNote}</em>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
