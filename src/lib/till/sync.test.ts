import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { TillDb } from "./db";
import type { TillSnapshotDto } from "./snapshot";
import { forgetOnLogout, offlineReadiness, outboxSummary, rememberTill, retryFailed, saveOfflineReturn, saveOfflineSale, saveSnapshot, unsyncedExport } from "./store";
import { backoffMs, refreshSnapshot, syncOutbox, type SyncDeps } from "./sync";

// The till's local store and sync engine (decision 0006; blueprint 8.2 and
// 8.4) against an in-memory IndexedDB and a scripted server.

const NOW = Date.parse("2026-10-04T06:00:00Z");

const snapshot = (over: Partial<TillSnapshotDto> = {}): TillSnapshotDto => ({
  serverTime: new Date(NOW).toISOString(),
  till: { id: "till-1", name: "Counter 1", prefix: "T1", creditNotePrefix: "T1R", branchId: "b1", branchName: "Main" },
  user: { id: "user-1", mayGiveAnyDiscount: false, mayReturnAfterWindow: false },
  settings: {
    ready: true,
    businessName: "Till Shop",
    sellerAddress: "12 Market Road",
    gstin: "33ABCDE1234F1Z7",
    stateCode: "33",
    pricesIncludeTax: true,
    chargesGst: true,
    discountLimitBps: 500,
    timeZone: "Asia/Kolkata",
    financialYearStartMonth: 4,
    returnWindowDays: 7,
    offlineWindowHours: 72,
  },
  items: [{ variantId: "v1", name: "Shirt", sku: "SH-M", codes: ["sh-m", "8901"], hsnCode: "6205", unitCode: "pcs", allowsFraction: false, trackSerial: false, pricePaise: 79_900, taxCategory: "cloth" }],
  taxRates: { cloth: [{ label: "GST 5%", rate: "5", priceMinPaise: null, priceMaxPaise: null, effectiveFrom: "2017-07-01", effectiveTo: null }] },
  serials: [],
  lastNumbers: [{ series: "invoice", financialYear: "26-27", last: 4 }],
  recentBills: [],
  ...over,
});

let db: TillDb;
let clock = NOW;
let calls: { url: string; body: unknown }[] = [];
let answers: (() => Response | Promise<Response>)[] = [];

const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const deps: SyncDeps = {
  fetch: (url, init) => {
    calls.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
    const next = answers.shift();
    if (next === undefined) throw new TypeError("Failed to fetch");
    return Promise.resolve(next());
  },
  now: () => clock,
  random: () => 0.5,
};

const shirt = { variantId: "v1", name: "Shirt", pricePaise: 79_900, taxCategory: "cloth", trackSerial: false };
const sell = (quantity = "1") => saveOfflineSale(db, { at: new Date(clock), madeBy: "user-1", lines: [{ item: shirt, quantity, discountPaise: 0, serial: null }], billDiscountPaise: 0, payments: [{ method: "cash", amountPaise: 79_900 * Number(quantity), reference: null }] });

beforeEach(async () => {
  db = new TillDb(`till-test-${String(Math.random())}`);
  clock = NOW;
  calls = [];
  answers = [];
  await rememberTill(db, { tillId: "till-1", name: "Counter 1", prefix: "T1", creditNotePrefix: "T1R", branchId: "b1", branchName: "Main", token: "t".repeat(43) });
  await saveSnapshot(db, snapshot(), NOW);
});

describe("the local store", () => {
  it("keeps the shop's copy: items by code (upper case), the numbers already used", async () => {
    expect((await db.items.where("codes").equals("SH-M").first())?.name).toBe("Shirt");
    expect(await db.counters.get("invoice|26-27")).toEqual({ key: "invoice|26-27", last: 4 });
  });

  it("an offline bill is saved with its outbox entry and the next number, all at once", async () => {
    const saved = await sell("2");
    expect(saved).toMatchObject({ number: "T1/26-27/00005", payablePaise: 159_800 });
    expect(await db.bills.get(saved.invoiceId)).toMatchObject({ pending: true, number: "T1/26-27/00005" });
    expect(await outboxSummary(db)).toEqual({ pending: 1, failed: 0, oldestPendingAt: NOW });
    expect((await sell()).number).toBe("T1/26-27/00006");
  });

  it("nothing is saved if any part fails (not fully paid)", async () => {
    await expect(saveOfflineSale(db, { at: new Date(clock), madeBy: "user-1", lines: [{ item: shirt, quantity: "1", discountPaise: 0, serial: null }], billDiscountPaise: 0, payments: [{ method: "cash", amountPaise: 100, reference: null }] })).rejects.toThrow("fully paid");
    expect(await db.bills.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.counters.get("invoice|26-27")).toEqual({ key: "invoice|26-27", last: 4 });
  });

  it("a refreshed copy never lowers the till's numbers and keeps its unconfirmed bills", async () => {
    const saved = await sell();
    await saveSnapshot(db, snapshot({ lastNumbers: [{ series: "invoice", financialYear: "26-27", last: 2 }] }), NOW);
    expect(await db.counters.get("invoice|26-27")).toEqual({ key: "invoice|26-27", last: 5 });
    expect(await db.bills.get(saved.invoiceId)).toMatchObject({ pending: true });
  });

  it("offline selling only within the window after the last online contact, for the person last online", async () => {
    expect((await offlineReadiness(db, NOW + 71 * 3_600_000)).ok).toBe(true);
    expect(await offlineReadiness(db, NOW + 73 * 3_600_000)).toEqual({ ok: false, reason: "window_expired", hoursAllowed: 72 });
    await db.meta.delete("session");
    expect(await offlineReadiness(db, NOW)).toEqual({ ok: false, reason: "not_logged_in" });
  });

  it("a return of a bill kept here: refund as the server works it out; not more than was sold", async () => {
    const saved = await sell("2");
    const line = (await db.bills.get(saved.invoiceId))?.lines[0];
    const back = await saveOfflineReturn(db, { at: new Date(clock), madeBy: "user-1", invoiceId: saved.invoiceId, lines: [{ invoiceItemId: line?.invoiceItemId ?? "", quantity: "1", resellable: true }], refundMethod: "cash", reason: "Wrong size" });
    expect(back).toMatchObject({ number: "T1R/26-27/00001", refundPaise: 79_900 });
    expect((await db.bills.get(saved.invoiceId))?.lines[0]?.returned).toBe("1.000");
    await expect(saveOfflineReturn(db, { at: new Date(clock), madeBy: "user-1", invoiceId: saved.invoiceId, lines: [{ invoiceItemId: line?.invoiceItemId ?? "", quantity: "2", resellable: true }], refundMethod: "cash", reason: "Again" })).rejects.toThrow("more than was sold");
  });
});

describe("logging out", () => {
  it("removes the shop's copy and who may sell; keeps the till, its numbers and what is not sent", async () => {
    const saved = await sell();
    await forgetOnLogout(db);
    expect(await db.items.count()).toBe(0);
    expect(await db.rates.count()).toBe(0);
    expect(await db.meta.get("session")).toBeUndefined();
    expect(await db.meta.get("settings")).toBeUndefined();
    expect(await db.meta.get("till")).toBeDefined();
    expect(await db.counters.get("invoice|26-27")).toEqual({ key: "invoice|26-27", last: 5 });
    expect(await outboxSummary(db)).toMatchObject({ pending: 1 });
    expect(await db.bills.get(saved.invoiceId)).toMatchObject({ pending: true });
    expect(await offlineReadiness(db, NOW)).toEqual({ ok: false, reason: "not_logged_in" });
  });
});

describe("the sync engine", () => {
  it("sends in order, marks done only when confirmed", async () => {
    const a = await sell();
    const b = await sell();
    answers = [() => json(200, { flags: [] }), () => json(200, { flags: ["stock_short"] })];
    expect(await syncOutbox(db, deps)).toBe("done");
    expect(calls.map((c) => (c.body as { number: string }).number)).toEqual([a.number, b.number]);
    expect((await db.outbox.toArray()).map((o) => [o.status, o.flags])).toEqual([["done", []], ["done", ["stock_short"]]]);
    expect(await db.bills.get(a.invoiceId)).toMatchObject({ pending: false });
  });

  it("no connection: waits with backoff (1 s, 2 s, 4 s ... 5 min, jittered) and keeps the order", async () => {
    await sell();
    await sell();
    expect(await syncOutbox(db, deps)).toBe("offline");
    const first = (await db.outbox.toArray())[0];
    expect(first).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: NOW + 750 });
    // Too early: nothing is sent, not even the second one.
    calls = [];
    expect(await syncOutbox(db, deps)).toBe("waiting");
    expect(calls).toEqual([]);
    expect([1, 2, 3, 10, 30].map((n) => backoffMs(n, 1))).toEqual([1000, 2000, 4000, 300_000, 300_000]);
    expect(backoffMs(3, 0)).toBe(2000);
  });

  it("a server error or 'its bill has not arrived' (409) retries; a refusal (422) goes to the failed list and the queue moves on", async () => {
    const a = await sell();
    const b = await sell();
    answers = [() => json(500, { code: "SERVER" })];
    expect(await syncOutbox(db, deps)).toBe("waiting");
    clock += 10_000;
    answers = [() => json(422, { code: "OFFLINE_TOTAL_MISMATCH", message: "The bill's total does not add up." }), () => json(200, { flags: [] })];
    expect(await syncOutbox(db, deps)).toBe("done");
    expect((await db.outbox.toArray()).map((o) => [o.number, o.status, o.lastError])).toEqual([
      [a.number, "failed", "The bill's total does not add up."],
      [b.number, "done", null],
    ]);
    expect(await outboxSummary(db)).toMatchObject({ pending: 0, failed: 1 });
    // Retry from the failed list.
    await retryFailed(db, (await db.outbox.toArray())[0]?.seq ?? 0);
    answers = [() => json(200, { flags: [] })];
    expect(await syncOutbox(db, deps)).toBe("done");
  });

  it("a return whose bill was refused is not sent; it waits on the failed list too", async () => {
    const sale = await sell();
    const line = (await db.bills.get(sale.invoiceId))?.lines[0];
    await saveOfflineReturn(db, { at: new Date(clock), madeBy: "user-1", invoiceId: sale.invoiceId, lines: [{ invoiceItemId: line?.invoiceItemId ?? "", quantity: "1", resellable: true }], refundMethod: "cash", reason: "Wrong size" });
    answers = [() => json(422, { code: "X", message: "Refused." })];
    expect(await syncOutbox(db, deps)).toBe("done");
    expect(calls).toHaveLength(1);
    expect((await db.outbox.toArray()).map((o) => o.status)).toEqual(["failed", "failed"]);
  });

  it("logged out or not allowed: waits, nothing lost; revoked: stops for good and keeps the unsynced list to export", async () => {
    await sell();
    answers = [() => json(401, { code: "LOGIN" })];
    expect(await syncOutbox(db, deps)).toBe("login");
    answers = [() => json(403, { code: "FORBIDDEN" })];
    expect(await syncOutbox(db, deps)).toBe("forbidden");
    answers = [() => json(410, { code: "TILL_REVOKED" })];
    expect(await syncOutbox(db, deps)).toBe("revoked");
    expect(await syncOutbox(db, deps)).toBe("revoked");
    expect((await offlineReadiness(db, NOW)).ok).toBe(false);
    const file = JSON.parse(await unsyncedExport(db, new Date(NOW))) as { operations: { number: string; status: string }[] };
    expect(file.operations).toEqual([expect.objectContaining({ number: "T1/26-27/00005", status: "pending" })]);
  });

  it("refreshing the copy counts as online contact; revoked is noticed there too", async () => {
    clock = NOW + 80 * 3_600_000;
    expect((await offlineReadiness(db, clock)).ok).toBe(false);
    answers = [() => json(200, snapshot())];
    expect(await refreshSnapshot(db, deps)).toBe("done");
    expect((await offlineReadiness(db, clock)).ok).toBe(true);
    answers = [() => json(410, { code: "TILL_REVOKED" })];
    expect(await refreshSnapshot(db, deps)).toBe("revoked");
  });
});
