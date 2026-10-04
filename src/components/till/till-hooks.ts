"use client";

import Dexie, { liveQuery } from "dexie";
import { useEffect, useState, useSyncExternalStore } from "react";
import { TILL_DB_NAME, tillDb, type TillDb } from "@/lib/till/db";
import type { SyncResult } from "@/lib/till/sync";

// Browser-side helpers for the till screens (decision 0006).

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

// The browser's own idea of the connection (switched off in tests).
export const useOnline = (): boolean => useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);

// The till store only if this computer is a till: other computers never
// get an empty database created.
export async function existingTillDb(): Promise<TillDb | null> {
  if (typeof indexedDB === "undefined") return null;
  return (await Dexie.exists(TILL_DB_NAME)) ? tillDb() : null;
}

// A value from the till store that updates itself when the store changes.
// `query` must be stable (a module-level function or a memoised one).
export function useTillQuery<T>(query: (db: TillDb) => Promise<T>, initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    let unsubscribe = (): void => undefined;
    let stopped = false;
    void existingTillDb().then((db) => {
      if (db === null || stopped) return;
      const subscription = liveQuery(() => query(db)).subscribe({ next: setValue, error: () => undefined });
      unsubscribe = () => {
        subscription.unsubscribe();
      };
    });
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [query]);
  return value;
}

// The last result of the background sync, for the status lines.
let lastResult: SyncResult | "never" = "never";
const listeners = new Set<() => void>();
export function setSyncResult(result: SyncResult): void {
  if (result === "busy" || result === lastResult) return;
  lastResult = result;
  for (const l of listeners) l();
}
export const useSyncResult = (): SyncResult | "never" =>
  useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => lastResult,
    () => "never",
  );

export const SYNC_RESULT_TEXT: Record<SyncResult | "never", string> = {
  never: "Not synced yet in this window.",
  done: "Everything is sent.",
  waiting: "Waiting to try again.",
  offline: "No connection: bills wait on this computer.",
  login: "Log in to send the waiting bills.",
  forbidden: "Your role may not send bills. Ask a manager to log in on this till.",
  not_registered: "This computer is not a registered till of this business.",
  revoked: "This till was revoked by a manager.",
  busy: "Sending…",
};
