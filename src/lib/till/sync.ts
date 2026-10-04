import type { TillSnapshotDto } from "./snapshot";
import { readMeta, type OutboxRow, type TillDb } from "./db";
import { markRevoked, saveSnapshot, touchOnline } from "./store";

// The till's sync engine (decision 0006; blueprint 8.2 step 4-6):
// - sends the outbox one entry at a time in the order it was made (a
//   return never goes before its bill);
// - marks an entry done only when the server confirmed it (a repeat is
//   confirmed too: the server answers with the first result);
// - no answer or a server error: try again later, waiting 1 s, 2 s, 4 s ...
//   up to 5 minutes, with random jitter so tills do not all retry at once;
// - refused (the server will never accept it as it is): moved to the
//   failed list with the reason, and the queue goes on;
// - not logged in / not allowed: waits, nothing is lost;
// - revoked: stops for good; the Sync page shows what was not sent.

export const OPERATIONS_URL = "/api/sync/operations";
export const SNAPSHOT_URL = "/api/sync/snapshot";
export const TILL_TOKEN_HEADER = "x-till-token";

export interface SyncDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  random: () => number;
}

export type SyncResult = "done" | "waiting" | "offline" | "login" | "forbidden" | "not_registered" | "revoked" | "busy";

// Equal jitter: half of the step is fixed, half random.
export function backoffMs(attempts: number, random: number): number {
  const step = Math.min(300_000, 1000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(step / 2 + (random * step) / 2);
}

async function answerOf(res: Response): Promise<{ code: string; message: string; flags: string[] }> {
  try {
    const body = (await res.json()) as { code?: unknown; message?: unknown; flags?: unknown };
    return {
      code: typeof body.code === "string" ? body.code : "",
      message: typeof body.message === "string" ? body.message : "",
      flags: Array.isArray(body.flags) ? body.flags.filter((f): f is string => typeof f === "string") : [],
    };
  } catch {
    return { code: "", message: "", flags: [] };
  }
}

async function later(db: TillDb, entry: OutboxRow, deps: SyncDeps, error: string): Promise<void> {
  const attempts = entry.attempts + 1;
  await db.outbox.update(entry.seq ?? 0, { attempts, nextAttemptAt: deps.now() + backoffMs(attempts, deps.random()), lastError: error });
}

// What 401/403/410 mean, for both calls.
async function stopFor(db: TillDb, res: Response): Promise<SyncResult | null> {
  if (res.status === 410) {
    await markRevoked(db);
    return "revoked";
  }
  if (res.status === 401) return "login";
  if (res.status === 403) return (await answerOf(res)).code === "TILL_UNKNOWN" ? "not_registered" : "forbidden";
  return null;
}

export async function syncOutbox(db: TillDb, deps: SyncDeps): Promise<SyncResult> {
  const till = await readMeta(db, "till");
  if (till === undefined) return "not_registered";
  if (till.revoked) return "revoked";
  for (let guard = 0; guard < 10_000; guard += 1) {
    const [entry] = await db.outbox.where("status").equals("pending").sortBy("seq");
    if (entry === undefined) return "done";
    if (entry.nextAttemptAt > deps.now()) return "waiting";
    // A return whose bill was refused cannot go either.
    if (entry.kind === "return") {
      const sale = await db.outbox.where("invoiceId").equals(entry.invoiceId).filter((o) => o.kind === "sale").first();
      if (sale?.status === "failed") {
        await db.outbox.update(entry.seq ?? 0, { status: "failed", lastError: `Its bill ${sale.number} could not be sent. Retry the bill first.` });
        continue;
      }
    }
    let res: Response;
    try {
      res = await deps.fetch(OPERATIONS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", [TILL_TOKEN_HEADER]: till.token },
        body: JSON.stringify(entry.payload),
        credentials: "same-origin",
      });
    } catch {
      await later(db, entry, deps, "No connection.");
      return "offline";
    }
    if (res.ok) {
      const { flags } = await answerOf(res);
      await db.transaction("rw", [db.outbox, db.bills, db.meta], async () => {
        await db.outbox.update(entry.seq ?? 0, { status: "done", flags, lastError: null });
        if (entry.kind === "sale") await db.bills.update(entry.invoiceId, { pending: false });
        await touchOnline(db, deps.now());
      });
      continue;
    }
    const stop = await stopFor(db, res);
    if (stop !== null) return stop;
    if (res.status === 422) {
      const { message } = await answerOf(res);
      await db.outbox.update(entry.seq ?? 0, { status: "failed", attempts: entry.attempts + 1, lastError: message === "" ? "Refused by the server." : message });
      continue;
    }
    // 409 (its bill has not arrived yet) and server errors: later.
    const { message } = await answerOf(res);
    await later(db, entry, deps, message === "" ? `Server error (${String(res.status)}).` : message);
    return "waiting";
  }
  return "waiting";
}

// Fetches the till's offline copy (items, prices, rates, IMEIs, recent
// bills). Also the till's online contact: the offline window starts again.
export async function refreshSnapshot(db: TillDb, deps: SyncDeps): Promise<SyncResult> {
  const till = await readMeta(db, "till");
  if (till === undefined) return "not_registered";
  if (till.revoked) return "revoked";
  let res: Response;
  try {
    res = await deps.fetch(SNAPSHOT_URL, { method: "GET", headers: { [TILL_TOKEN_HEADER]: till.token }, credentials: "same-origin", cache: "no-store" });
  } catch {
    return "offline";
  }
  if (res.ok) {
    await saveSnapshot(db, (await res.json()) as TillSnapshotDto, deps.now());
    return "done";
  }
  return (await stopFor(db, res)) ?? "offline";
}

// One sync at a time per browser (several tabs may be open): the Web Locks
// API where the browser has it.
let running = false;
export async function exclusive(work: () => Promise<SyncResult>): Promise<SyncResult> {
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    return navigator.locks.request("billing-till-sync", { ifAvailable: true }, async (lock) => (lock === null ? "busy" : work()));
  }
  if (running) return "busy";
  running = true;
  try {
    return await work();
  } finally {
    running = false;
  }
}
