"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { readMeta, wipeTill, type OutboxRow, type TillDb, type TillIdentity } from "@/lib/till/db";
import { outboxSummary, retryFailed, unsyncedExport, type OutboxSummary } from "@/lib/till/store";
import { exclusive, refreshSnapshot, syncOutbox } from "@/lib/till/sync";
import { existingTillDb, setSyncResult, SYNC_RESULT_TEXT, useOnline, useSyncResult, useTillQuery } from "./till-hooks";

// Sync status (blueprint 8.4): what waits on this till, the oldest waiting
// item, failed items with the exact reason, retry, and a file of anything
// not sent. A revoked till shows what was not sent, lets it be saved as a
// file, and then wipes this computer's till data.

const tillOf = async (db: TillDb): Promise<TillIdentity | null> => (await readMeta(db, "till")) ?? null;
const summaryOf = (db: TillDb): Promise<OutboxSummary> => outboxSummary(db);
const waitingOf = (db: TillDb): Promise<OutboxRow[]> => db.outbox.where("status").anyOf("pending", "failed").sortBy("seq");
const recentOf = async (db: TillDb): Promise<OutboxRow[]> => (await db.outbox.where("status").equals("done").reverse().sortBy("seq")).slice(0, 20);

const FLAG_TEXT: Record<string, string> = {
  stock_short: "stock went below zero",
  price_changed: "price had changed",
  tax_changed: "GST rate had changed",
  settings_changed: "pricing setting had changed",
  discount_over_limit: "discount above the limit",
  item_archived: "item was archived",
  imei_unavailable: "IMEI already sold elsewhere",
  role_removed: "seller's role was removed",
  date_corrected: "till clock was wrong",
  number_gap: "a bill number was skipped",
  return_after_window: "return after the return period",
  refund_differs: "refund worked out differently",
};

function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)} h` : `${String(Math.floor(hours / 24))} days`;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function SyncStatus(): ReactNode {
  const online = useOnline();
  const result = useSyncResult();
  const till = useTillQuery(tillOf, null);
  const summary = useTillQuery(summaryOf, { pending: 0, failed: 0, oldestPendingAt: null });
  const waiting = useTillQuery(waitingOf, []);
  const recent = useTillQuery(recentOf, []);
  const [now, setNow] = useState(() => Date.now());
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [exported, setExported] = useState(false);
  const [wiped, setWiped] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, 30_000);
    if ("storage" in navigator && typeof navigator.storage.persisted === "function") {
      void navigator.storage.persisted().then(setPersisted, () => { setPersisted(null); });
    }
    return () => {
      clearInterval(timer);
    };
  }, []);

  const syncNow = async (): Promise<void> => {
    const db = await existingTillDb();
    if (db === null) return;
    setBusy(true);
    const deps = { fetch: (url: string, init: RequestInit) => fetch(url, init), now: Date.now, random: Math.random };
    const r = await exclusive(async () => {
      const sent = await syncOutbox(db, deps);
      return sent === "done" ? refreshSnapshot(db, deps) : sent;
    });
    setSyncResult(r);
    setBusy(false);
  };

  const exportAll = async (): Promise<void> => {
    const db = await existingTillDb();
    if (db === null) return;
    download(`unsynced-${till?.prefix ?? "till"}-${new Date().toISOString().slice(0, 10)}.json`, await unsyncedExport(db, new Date()));
    setExported(true);
  };

  const retry = async (seq: number | undefined): Promise<void> => {
    const db = await existingTillDb();
    if (db === null || seq === undefined) return;
    await retryFailed(db, seq);
    // Its returns go back in the queue with it.
    const failed = await db.outbox.where("status").equals("failed").toArray();
    const entry = await db.outbox.get(seq);
    for (const f of failed) if (entry?.kind === "sale" && f.kind === "return" && f.invoiceId === entry.invoiceId) await retryFailed(db, f.seq ?? 0);
    if (online) void syncNow();
  };

  const wipe = async (): Promise<void> => {
    const db = await existingTillDb();
    if (db !== null) await wipeTill(db);
    setWiped(true);
  };

  if (wiped) return <p role="status">This computer&apos;s till data was removed. It is no longer a till.</p>;
  if (till === null) return <p className="text-sm text-muted-foreground">This computer is not a registered till. A manager can register it in Tills.</p>;

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {till.revoked ? (
        <section role="alert" className="flex flex-col gap-2 rounded-lg border border-destructive p-3 text-sm">
          <p className="font-semibold text-destructive">This till was revoked by a manager.</p>
          <p>
            {waiting.length === 0
              ? "Nothing is waiting to be sent."
              : `${String(waiting.length)} bill(s) or return(s) were NOT sent to the business. Save them as a file and give it to a manager before removing this till's data.`}
          </p>
          <div className="flex flex-wrap gap-2">
            {waiting.length > 0 ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void exportAll()}>
                Save unsent items as a file
              </Button>
            ) : null}
            <Button type="button" variant="destructive" size="sm" disabled={waiting.length > 0 && !exported} onClick={() => void wipe()}>
              Remove this till&apos;s data
            </Button>
          </div>
        </section>
      ) : null}

      <dl className="grid max-w-md grid-cols-2 gap-1 text-sm" aria-label="Sync summary">
        <dt>Till</dt>
        <dd>
          {till.name} ({till.prefix}) · {till.branchName}
        </dd>
        <dt>Connection</dt>
        <dd>{online ? "Online" : "Offline"}</dd>
        <dt>Waiting to sync</dt>
        <dd>{summary.pending}</dd>
        <dt>Oldest waiting</dt>
        <dd>{summary.oldestPendingAt === null ? "–" : age(now - summary.oldestPendingAt)}</dd>
        <dt>Failed</dt>
        <dd>{summary.failed}</dd>
        <dt>Last sync</dt>
        <dd>{SYNC_RESULT_TEXT[result]}</dd>
      </dl>
      {persisted === false ? (
        <p className="text-sm text-amber-700">This browser may clear the till&apos;s saved bills when space runs low. Keep the till online often so bills are sent.</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={!online || busy || till.revoked} onClick={() => void syncNow()}>
          {busy ? "Syncing…" : "Sync now"}
        </Button>
        {waiting.length > 0 && !till.revoked ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void exportAll()}>
            Save unsent items as a file
          </Button>
        ) : null}
      </div>

      <section aria-label="Waiting and failed" className="flex flex-col gap-2">
        <h2 className="font-semibold">Waiting and failed</h2>
        {waiting.length === 0 ? <p className="text-sm text-muted-foreground">Nothing waiting.</p> : null}
        {waiting.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="border-b text-left">
              <tr>
                <th className="p-1 font-medium">Number</th>
                <th className="p-1 font-medium">What</th>
                <th className="p-1 font-medium">Made</th>
                <th className="p-1 font-medium">State</th>
                <th className="p-1" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {waiting.map((o) => (
                <tr key={o.opId} aria-label={o.number}>
                  <td className="p-1">{o.number}</td>
                  <td className="p-1">{o.kind === "sale" ? "Bill" : "Return"}</td>
                  <td className="p-1">{new Date(o.createdAt).toLocaleString("en-IN")}</td>
                  <td className="p-1">
                    {o.status === "failed" ? <span className="text-destructive">Failed: {o.lastError}</span> : o.lastError === null ? "Waiting" : `Waiting (${o.lastError})`}
                  </td>
                  <td className="p-1 text-right">
                    {o.status === "failed" && !till.revoked ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => void retry(o.seq)}>
                        Retry
                      </Button>
                    ) : null}{" "}
                    <Button type="button" variant="ghost" size="sm" onClick={() => { download(`${o.number.replace(/\//g, "-")}.json`, JSON.stringify(o.payload, null, 2)); }}>
                      Save as file
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      {recent.length > 0 ? (
        <section aria-label="Recently sent" className="flex flex-col gap-2">
          <h2 className="font-semibold">Recently sent</h2>
          <ul className="text-sm">
            {recent.map((o) => (
              <li key={o.opId}>
                {o.number} · {o.kind === "sale" ? "bill" : "return"} · sent
                {o.flags.length > 0 ? ` · for a manager to check: ${o.flags.map((f) => FLAG_TEXT[f] ?? f).join(", ")}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
