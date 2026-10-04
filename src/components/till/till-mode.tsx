"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { PosScreen, type PosActions } from "@/components/pos/pos-screen";
import { readMeta, type TillDb, type TillIdentity } from "@/lib/till/db";
import { outboxSummary, type OutboxSummary } from "@/lib/till/store";
import type { PosSetupDto } from "@/modules/sales";
import { OfflineTill } from "./offline-till";
import { SYNC_RESULT_TEXT, useOnline, useSyncResult, useTillQuery } from "./till-hooks";

// The till page (decision 0006): online billing as before, or, on a
// registered till with no connection (or when the cashier chooses it on a
// shaky connection), offline billing from the till's own copy. The strip
// says which, and how many bills wait to be sent.

const tillOf = async (db: TillDb): Promise<TillIdentity | null> => (await readMeta(db, "till")) ?? null;
const summaryOf = (db: TillDb): Promise<OutboxSummary> => outboxSummary(db);

export function TillMode(props: { setup: PosSetupDto; branches: { id: string; name: string }[]; actions: PosActions }): ReactNode {
  const online = useOnline();
  const till = useTillQuery(tillOf, null);
  const summary = useTillQuery(summaryOf, { pending: 0, failed: 0, oldestPendingAt: null });
  const sync = useSyncResult();
  const [chosenOffline, setChosenOffline] = useState(false);
  const registered = till !== null && !till.revoked;
  const offline = registered && (!online || chosenOffline);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2 text-sm" role="status" aria-label="Till status">
        {till === null ? (
          <span className="text-muted-foreground">This computer is not a registered till: it cannot bill without internet.</span>
        ) : (
          <>
            <span className="font-medium">
              {till.name} ({till.prefix})
            </span>
            <span>{offline ? "Offline billing" : "Online"}</span>
            <span>
              {summary.pending} waiting to sync{summary.failed > 0 ? ` · ${String(summary.failed)} failed` : ""}
            </span>
            {online ? <span className="text-muted-foreground">{SYNC_RESULT_TEXT[sync]}</span> : null}
            {till.revoked ? <span className="text-destructive">This till was revoked.</span> : null}
          </>
        )}
        <Link href="/sync" className="underline">
          Sync status
        </Link>
        {registered && online ? (
          <Button type="button" variant="outline" size="sm" onClick={() => { setChosenOffline(!chosenOffline); }}>
            {chosenOffline ? "Back to online billing" : "Bill offline"}
          </Button>
        ) : null}
      </div>
      {offline ? <OfflineTill /> : <PosScreen {...props} tillId={registered ? till.tillId : null} />}
    </div>
  );
}
