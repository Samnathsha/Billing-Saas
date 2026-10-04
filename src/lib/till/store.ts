import { financialYearOfDay } from "@/lib/document-number";
import { dayIn, makeOfflineReturn, makeOfflineSale, type OfflineCartLine, type OfflinePayment, type OfflineReturnOpShape } from "@/lib/offline-bill";
import { quantityToMilli } from "@/lib/bill-maths";
import type { TillSnapshotDto } from "./snapshot";
import { readMeta, type KeptBillRow, type OutboxRow, type TillDb, type TillIdentity, type TillSettings } from "./db";

// What the till does with its local store (decision 0006). Every offline
// bill or return is saved in ONE IndexedDB transaction together with its
// outbox entry and its number (blueprint 8.2): all of it or nothing.

const milliText = (milli: bigint): string => `${String(milli / 1000n)}.${String(milli % 1000n).padStart(3, "0")}`;

export async function rememberTill(db: TillDb, till: Omit<TillIdentity, "key" | "revoked">): Promise<void> {
  await db.meta.put({ key: "till", ...till, revoked: false });
}

// The server's copy replaces the local one, except what this till made
// offline and has not had confirmed yet: its bills, its returns' effect on
// them, its numbers and the IMEIs it sold.
export async function saveSnapshot(db: TillDb, snapshot: TillSnapshotDto, now: number): Promise<void> {
  await db.transaction("rw", [db.meta, db.items, db.rates, db.serials, db.counters, db.bills, db.outbox], async () => {
    const till = await readMeta(db, "till");
    if (till === undefined) return;
    await db.meta.put({ ...till, name: snapshot.till.name, branchId: snapshot.till.branchId, branchName: snapshot.till.branchName });
    await db.meta.put({ key: "settings", ...snapshot.settings });
    await db.meta.put({ key: "session", userId: snapshot.user.id, mayGiveAnyDiscount: snapshot.user.mayGiveAnyDiscount, mayReturnAfterWindow: snapshot.user.mayReturnAfterWindow, lastOnlineAt: now });

    await db.items.clear();
    await db.items.bulkPut(snapshot.items.map((i) => ({ ...i, codes: [...new Set(i.codes.map((c) => c.toUpperCase()))] })));
    await db.rates.clear();
    await db.rates.bulkPut(Object.entries(snapshot.taxRates).map(([category, rows]) => ({ category, rows })));

    const waiting = await db.outbox.where("status").anyOf("pending", "failed").toArray();
    const soldHere = new Set(waiting.flatMap((o) => (o.payload.kind === "sale" ? o.payload.lines.flatMap((l) => (l.serial === null ? [] : [l.serial.toUpperCase()])) : [])));
    await db.serials.clear();
    await db.serials.bulkPut(snapshot.serials.filter((s) => !soldHere.has(s.serial.toUpperCase())).map((s) => ({ serial: s.serial.toUpperCase(), variantId: s.variantId, soldHere: false })));

    for (const n of snapshot.lastNumbers) {
      const key = `${n.series}|${n.financialYear}`;
      const local = await db.counters.get(key);
      if (local === undefined || local.last < n.last) await db.counters.put({ key, last: n.last });
    }

    // Bills: the server's, plus this till's unconfirmed ones; returns not
    // yet confirmed still count against the lines.
    const pendingBills = await db.bills.filter((b) => b.pending).toArray();
    const unconfirmedReturns = waiting.flatMap((o) => (o.payload.kind === "return" ? [o.payload] : []));
    const serverBills: KeptBillRow[] = snapshot.recentBills.map((b) => ({ ...b, pending: false }));
    await db.bills.clear();
    await db.bills.bulkPut([...serverBills.filter((b) => !pendingBills.some((p) => p.invoiceId === b.invoiceId)), ...pendingBills].map((b) => withUnconfirmedReturns(b, unconfirmedReturns, pendingBills.some((p) => p.invoiceId === b.invoiceId))));
  });
}

// A server bill's "returned" does not know this till's unsynced returns;
// a pending (local) bill's already does.
function withUnconfirmedReturns(bill: KeptBillRow, returns: OfflineReturnOpShape[], local: boolean): KeptBillRow {
  if (local) return bill;
  const mine = returns.filter((r) => r.invoiceId === bill.invoiceId);
  if (mine.length === 0) return bill;
  return {
    ...bill,
    lines: bill.lines.map((l) => {
      const extra = mine.flatMap((r) => r.lines.filter((x) => x.invoiceItemId === l.invoiceItemId)).reduce((sum, x) => sum + quantityToMilli(x.quantity), 0n);
      return extra === 0n ? l : { ...l, returned: milliText(quantityToMilli(l.returned) + extra) };
    }),
  };
}

export async function touchOnline(db: TillDb, now: number): Promise<void> {
  const session = await readMeta(db, "session");
  if (session !== undefined) await db.meta.put({ ...session, lastOnlineAt: now });
}

export async function markRevoked(db: TillDb): Promise<void> {
  const till = await readMeta(db, "till");
  if (till !== undefined) await db.meta.put({ ...till, revoked: true });
}

// Logging out: the next person must log in online before selling offline.
export async function forgetSession(db: TillDb): Promise<void> {
  await db.meta.delete("session");
}

export type OfflineReadiness =
  | { ok: true; till: TillIdentity; settings: TillSettings; session: { userId: string; mayGiveAnyDiscount: boolean; mayReturnAfterWindow: boolean; lastOnlineAt: number } }
  | { ok: false; reason: "not_registered" | "revoked" | "no_copy" | "not_logged_in" | "window_expired" | "settings_incomplete"; hoursAllowed?: number };

// May this till sell offline now? Only a registered, not revoked till with
// a copy of the shop, for the person last online here, within the offline
// window after the last online contact (business rules 17).
export async function offlineReadiness(db: TillDb, now: number): Promise<OfflineReadiness> {
  const till = await readMeta(db, "till");
  if (till === undefined) return { ok: false, reason: "not_registered" };
  if (till.revoked) return { ok: false, reason: "revoked" };
  const settings = await readMeta(db, "settings");
  if (settings === undefined) return { ok: false, reason: "no_copy" };
  if (!settings.ready) return { ok: false, reason: "settings_incomplete" };
  const session = await readMeta(db, "session");
  if (session === undefined) return { ok: false, reason: "not_logged_in" };
  if (now - session.lastOnlineAt > settings.offlineWindowHours * 3_600_000) return { ok: false, reason: "window_expired", hoursAllowed: settings.offlineWindowHours };
  return { ok: true, till, settings, session };
}

async function takeNumber(db: TillDb, series: "invoice" | "credit_note", financialYear: string): Promise<number> {
  const key = `${series}|${financialYear}`;
  const next = ((await db.counters.get(key))?.last ?? 0) + 1;
  await db.counters.put({ key, last: next });
  return next;
}

export async function saveOfflineSale(
  db: TillDb,
  input: { at: Date; madeBy: string; lines: OfflineCartLine[]; billDiscountPaise: number; payments: OfflinePayment[] },
): Promise<{ invoiceId: string; number: string; payablePaise: number; op: OutboxRow["payload"] }> {
  return db.transaction("rw", [db.meta, db.rates, db.counters, db.bills, db.outbox, db.serials], async () => {
    const till = await readMeta(db, "till");
    const settings = await readMeta(db, "settings");
    if (till === undefined || settings === undefined || till.revoked) throw new Error("This computer cannot sell offline.");
    const taxRates = Object.fromEntries((await db.rates.toArray()).map((r) => [r.category, r.rows]));
    const day = dayIn(input.at, settings.timeZone);
    const sequence = await takeNumber(db, "invoice", financialYearOfDay(day, settings.financialYearStartMonth));
    const invoiceId = crypto.randomUUID();
    const lineIds = input.lines.map(() => crypto.randomUUID());
    const made = makeOfflineSale({ opId: crypto.randomUUID(), invoiceId, lineIds, madeBy: input.madeBy, at: input.at, settings, taxRates, prefix: till.prefix, sequence, lines: input.lines, billDiscountPaise: input.billDiscountPaise, payments: input.payments });
    if (input.payments.reduce((s, p) => s + p.amountPaise, 0) !== made.bill.payablePaise) throw new Error("An offline bill must be fully paid.");
    await db.bills.put({
      invoiceId,
      number: made.op.number,
      invoiceDate: made.op.invoiceDate,
      payablePaise: made.bill.payablePaise,
      pending: true,
      lines: input.lines.map((l, i) => {
        const amounts = made.bill.lines[i];
        return {
          invoiceItemId: lineIds[i] ?? "",
          lineNumber: i + 1,
          name: l.item.name,
          sku: "",
          serial: l.serial,
          unitCode: "",
          sold: milliText(quantityToMilli(l.quantity)),
          returned: "0.000",
          taxablePaise: amounts?.taxablePaise ?? 0,
          cgstPaise: amounts?.cgstPaise ?? 0,
          igstPaise: amounts?.igstPaise ?? 0,
          totalPaise: amounts?.totalPaise ?? 0,
        };
      }),
    });
    await db.outbox.add({ opId: made.op.opId, kind: "sale", number: made.op.number, invoiceId, payload: made.op, createdAt: input.at.getTime(), status: "pending", attempts: 0, nextAttemptAt: 0, lastError: null, flags: [] });
    for (const l of input.lines) {
      if (l.serial !== null) {
        const row = await db.serials.get(l.serial.toUpperCase());
        if (row !== undefined) await db.serials.put({ ...row, soldHere: true });
      }
    }
    return { invoiceId, number: made.op.number, payablePaise: made.bill.payablePaise, op: made.op };
  });
}

export async function saveOfflineReturn(
  db: TillDb,
  input: { at: Date; madeBy: string; invoiceId: string; lines: { invoiceItemId: string; quantity: string; resellable: boolean }[]; refundMethod: "cash" | "card" | "upi"; reason: string },
): Promise<{ creditNoteId: string; number: string; refundPaise: number }> {
  return db.transaction("rw", [db.meta, db.counters, db.bills, db.outbox], async () => {
    const till = await readMeta(db, "till");
    const settings = await readMeta(db, "settings");
    if (till === undefined || settings === undefined || till.revoked) throw new Error("This computer cannot take returns offline.");
    const bill = await db.bills.get(input.invoiceId);
    if (bill === undefined) throw new Error("Only bills kept on this till can be returned offline.");
    const lines = input.lines.map((l) => {
      const line = bill.lines.find((x) => x.invoiceItemId === l.invoiceItemId);
      if (line === undefined) throw new Error("That item is not on this bill.");
      if (quantityToMilli(line.returned) + quantityToMilli(l.quantity) > quantityToMilli(line.sold)) throw new Error(`That is more than was sold (${line.name}).`);
      return { line, quantity: l.quantity, resellable: l.resellable };
    });
    const day = dayIn(input.at, settings.timeZone);
    const sequence = await takeNumber(db, "credit_note", financialYearOfDay(day, settings.financialYearStartMonth));
    const creditNoteId = crypto.randomUUID();
    const made = makeOfflineReturn({ opId: crypto.randomUUID(), creditNoteId, madeBy: input.madeBy, at: input.at, settings, prefix: till.creditNotePrefix, sequence, invoiceId: input.invoiceId, lines, refundMethod: input.refundMethod, reason: input.reason });
    await db.bills.put({
      ...bill,
      lines: bill.lines.map((l) => {
        const now = input.lines.find((x) => x.invoiceItemId === l.invoiceItemId);
        return now === undefined ? l : { ...l, returned: milliText(quantityToMilli(l.returned) + quantityToMilli(now.quantity)) };
      }),
    });
    await db.outbox.add({ opId: made.op.opId, kind: "return", number: made.op.number, invoiceId: input.invoiceId, payload: made.op, createdAt: input.at.getTime(), status: "pending", attempts: 0, nextAttemptAt: 0, lastError: null, flags: [] });
    return { creditNoteId, number: made.op.number, refundPaise: made.refundPaise };
  });
}

export interface OutboxSummary {
  pending: number;
  failed: number;
  oldestPendingAt: number | null;
}

export async function outboxSummary(db: TillDb): Promise<OutboxSummary> {
  const waiting = await db.outbox.where("status").anyOf("pending", "failed").toArray();
  const pending = waiting.filter((o) => o.status === "pending");
  return {
    pending: pending.length,
    failed: waiting.length - pending.length,
    oldestPendingAt: pending.length === 0 ? null : Math.min(...pending.map((o) => o.createdAt)),
  };
}

// Back into the queue at its own place (it keeps its order).
export async function retryFailed(db: TillDb, seq: number): Promise<void> {
  await db.outbox.update(seq, { status: "pending", attempts: 0, nextAttemptAt: 0, lastError: null });
}

// Everything not confirmed by the server, as a file to keep or show a
// manager (blueprint 8.4).
export async function unsyncedExport(db: TillDb, now: Date): Promise<string> {
  const till = await readMeta(db, "till");
  const rows = await db.outbox.where("status").anyOf("pending", "failed").sortBy("seq");
  return JSON.stringify(
    {
      exportedAt: now.toISOString(),
      till: till === undefined ? null : { name: till.name, prefix: till.prefix },
      operations: rows.map((r) => ({ number: r.number, kind: r.kind, status: r.status, lastError: r.lastError, createdAt: new Date(r.createdAt).toISOString(), operation: r.payload })),
    },
    null,
    2,
  );
}

