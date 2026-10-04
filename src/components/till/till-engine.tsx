"use client";

import { useEffect, type ReactNode } from "react";
import { readMeta } from "@/lib/till/db";
import { exclusive, refreshSnapshot, syncOutbox, type SyncDeps } from "@/lib/till/sync";
import { existingTillDb, setSyncResult, useOnline } from "./till-hooks";

// Runs on every page while this computer is a registered till (decision
// 0006): sends the outbox whenever there is a connection (and the browser
// says it is back), and refreshes the till's offline copy every few
// minutes. Renders nothing.

const SYNC_EVERY_MS = 5_000;
const REFRESH_EVERY_MS = 5 * 60_000;

export function TillEngine(): ReactNode {
  const online = useOnline();
  useEffect(() => {
    if (!online) {
      setSyncResult("offline");
      return;
    }
    const run = { stopped: false, lastRefresh: 0 };
    // Read through a function: the effect may end while a sync is running.
    const ended = (): boolean => run.stopped;
    const deps: SyncDeps = { fetch: (url, init) => fetch(url, init), now: Date.now, random: Math.random };
    const tick = async (): Promise<void> => {
      const db = await existingTillDb();
      if (db === null || ended()) return;
      const till = await readMeta(db, "till");
      if (till === undefined) return;
      // Keep this browser's data: ask once, quietly (blueprint 8.4).
      if ("storage" in navigator && typeof navigator.storage.persist === "function") void navigator.storage.persist().catch(() => false);
      const result = await exclusive(async () => {
        const sent = await syncOutbox(db, deps);
        if (sent === "revoked" || sent === "login" || sent === "not_registered") return sent;
        if (Date.now() - run.lastRefresh > REFRESH_EVERY_MS) {
          const refreshed = await refreshSnapshot(db, deps);
          if (refreshed === "done") run.lastRefresh = Date.now();
          else return refreshed;
        }
        return sent;
      });
      if (!ended()) setSyncResult(result);
    };
    void tick();
    const timer = setInterval(() => void tick(), SYNC_EVERY_MS);
    return () => {
      run.stopped = true;
      clearInterval(timer);
    };
  }, [online]);
  return null;
}
