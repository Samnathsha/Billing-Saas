"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BillMathError, discountWithinLimit, quantityToMilli, type BillResult } from "@/lib/bill-maths";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { dayIn, priceOfflineBill, refundFor, type OfflineCartLine } from "@/lib/offline-bill";
import { formatQuantity } from "@/lib/quantity";
import { TaxRateError, type TaxRateRow } from "@/lib/tax-pick";
import type { ItemRow, KeptBillRow, TillDb } from "@/lib/till/db";
import { offlineReadiness, saveOfflineReturn, saveOfflineSale, type OfflineReadiness } from "@/lib/till/store";
import { existingTillDb, useTillQuery } from "./till-hooks";

// Billing with no internet (decision 0006; business rules 17). Everything
// comes from this till's own copy: items, selling prices, GST rates, IMEIs
// in stock here. The bill is worked out with the same maths as the server,
// saved on this computer together with its outbox entry, and printed with
// a PENDING SYNC mark and the till's own number. No credit offline: the
// bill must be fully paid. Returns: only bills kept on this till.

interface Line {
  key: string;
  item: ItemRow;
  quantity: string;
  discount: string;
  serial: string;
}

const paiseOf = (text: string): number | null => (text.trim() === "" ? 0 : rupeesToPaise(text));
const milliText = (milli: bigint): string => `${String(milli / 1000n)}.${String(milli % 1000n).padStart(3, "0")}`;

const NOT_READY: Record<Exclude<OfflineReadiness, { ok: true }>["reason"], string> = {
  not_registered: "This computer is not a registered till, so it cannot bill offline.",
  revoked: "This till was revoked by a manager. Open Sync status.",
  no_copy: "This till has no copy of the shop yet. Connect to the internet once to download it.",
  not_logged_in: "Log in while online to bill offline on this till.",
  window_expired: "Offline billing has stopped: this till has not been online for too long. Connect to the internet.",
  settings_incomplete: "Set the business's state and GST registration in Business settings before billing.",
};

async function findItems(db: TillDb, text: string): Promise<ItemRow[]> {
  const code = text.trim().toUpperCase();
  const exact = await db.items.where("codes").equals(code).toArray();
  if (exact.length > 0) return exact.slice(0, 1);
  const words = code.toLowerCase();
  return db.items
    .filter((i) => i.name.toLowerCase().includes(words) || i.sku.toLowerCase().startsWith(words))
    .limit(20)
    .toArray();
}

const allRates = async (db: TillDb): Promise<Record<string, TaxRateRow[]>> => Object.fromEntries((await db.rates.toArray()).map((r) => [r.category, r.rows]));
const keptBills = async (db: TillDb): Promise<KeptBillRow[]> => (await db.bills.orderBy("invoiceDate").reverse().toArray()).slice(0, 300);

interface Receipt {
  kind: "bill" | "credit_note";
  number: string;
  at: Date;
  lines: { name: string; quantity: string; amountPaise: number }[];
  bill: BillResult | null;
  refundPaise: number;
  payments: { method: string; amountPaise: number }[];
  changePaise: number;
}

export function OfflineTill(): ReactNode {
  const [readiness, setReadiness] = useState<OfflineReadiness | null>(null);
  const [mode, setMode] = useState<"bill" | "return">("bill");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const rates = useTillQuery(allRates, {});

  useEffect(() => {
    let stopped = false;
    const check = async (): Promise<void> => {
      const db = await existingTillDb();
      const result: OfflineReadiness = db === null ? { ok: false, reason: "not_registered" } : await offlineReadiness(db, Date.now());
      if (!stopped) setReadiness(result);
    };
    void check();
    const timer = setInterval(() => void check(), 30_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  if (readiness === null) return <p className="text-sm text-muted-foreground">Opening this till…</p>;
  if (!readiness.ok) {
    return (
      <p role="alert" className="rounded-lg border border-destructive p-3 text-sm text-destructive">
        {NOT_READY[readiness.reason]}
        {readiness.reason === "window_expired" && readiness.hoursAllowed !== undefined ? ` (allowed: ${String(readiness.hoursAllowed)} hours after the last online contact)` : ""}
      </p>
    );
  }
  if (receipt !== null) return <ReceiptView receipt={receipt} readiness={readiness} onNext={() => { setReceipt(null); }} />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2" role="tablist" aria-label="Offline till">
        <Button type="button" role="tab" aria-selected={mode === "bill"} variant={mode === "bill" ? "default" : "outline"} size="sm" onClick={() => { setMode("bill"); }}>
          New bill
        </Button>
        <Button type="button" role="tab" aria-selected={mode === "return"} variant={mode === "return" ? "default" : "outline"} size="sm" onClick={() => { setMode("return"); }}>
          Return (this till&apos;s bills)
        </Button>
      </div>
      {mode === "bill" ? <OfflineBill readiness={readiness} rates={rates} onSaved={setReceipt} /> : <OfflineReturn readiness={readiness} onSaved={setReceipt} />}
    </div>
  );
}

function OfflineBill(props: { readiness: Extract<OfflineReadiness, { ok: true }>; rates: Record<string, TaxRateRow[]>; onSaved: (r: Receipt) => void }): ReactNode {
  const { settings, session } = props.readiness;
  const [lines, setLines] = useState<Line[]>([]);
  const [code, setCode] = useState("");
  const [hits, setHits] = useState<ItemRow[]>([]);
  const [billDiscount, setBillDiscount] = useState("");
  const [cash, setCash] = useState("");
  const [upi, setUpi] = useState("");
  const [card, setCard] = useState("");
  const [reference, setReference] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  const preview = useMemo((): { bill: BillResult | null; rates: { label: string; rate: string }[]; problem: string | null } => {
    if (lines.length === 0) return { bill: null, rates: [], problem: null };
    const discounts = lines.map((l) => paiseOf(l.discount));
    const billDiscountPaise = paiseOf(billDiscount);
    if (discounts.some((d) => d === null) || billDiscountPaise === null) return { bill: null, rates: [], problem: "Enter discounts in rupees, e.g. 50 or 49.50." };
    try {
      const cart: OfflineCartLine[] = lines.map((l, i) => ({ item: l.item, quantity: l.quantity.trim(), discountPaise: discounts[i] ?? 0, serial: null }));
      const priced = priceOfflineBill(settings, props.rates, dayIn(new Date(), settings.timeZone), cart, billDiscountPaise);
      if (!discountWithinLimit(priced.bill, session.mayGiveAnyDiscount ? null : settings.discountLimitBps)) return { ...priced, problem: "This discount is above your limit. Ask a manager." };
      return { ...priced, problem: null };
    } catch (error) {
      if (error instanceof BillMathError || error instanceof TaxRateError) return { bill: null, rates: [], problem: error.message };
      return { bill: null, rates: [], problem: "Please check the bill." };
    }
  }, [lines, billDiscount, settings, session, props.rates]);

  const payable = preview.bill?.payablePaise ?? 0;
  const cashPaise = paiseOf(cash);
  const upiPaise = paiseOf(upi);
  const cardPaise = paiseOf(card);
  const paymentsValid = cashPaise !== null && upiPaise !== null && cardPaise !== null;
  const nonCash = (upiPaise ?? 0) + (cardPaise ?? 0);
  const cashKept = Math.max(0, Math.min(cashPaise ?? 0, payable - nonCash));
  const unpaid = payable - nonCash - cashKept;
  const change = (cashPaise ?? 0) - cashKept;

  const addItem = (item: ItemRow): void => {
    setLines((current) => {
      const same = item.trackSerial ? undefined : current.find((l) => l.item.variantId === item.variantId);
      if (same !== undefined && /^\d+$/.test(same.quantity)) return current.map((l) => (l === same ? { ...l, quantity: String(Number(l.quantity) + 1) } : l));
      return [...current, { key: crypto.randomUUID(), item, quantity: "1", discount: "", serial: "" }];
    });
    setHits([]);
    setCode("");
    setMessage(null);
  };

  const scan = async (): Promise<void> => {
    const text = code.trim();
    if (text === "") return;
    const db = await existingTillDb();
    if (db === null) return;
    const found = await findItems(db, text);
    const [only] = found;
    if (found.length === 1 && only !== undefined && only.codes.includes(text.toUpperCase())) {
      addItem(only);
      return;
    }
    setHits(found);
    setMessage(found.length === 0 ? `Nothing found for "${text}" on this till.` : null);
  };

  const update = (key: string, change: Partial<Line>): void => {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...change } : l)));
  };

  const save = async (): Promise<void> => {
    if (saving || preview.bill === null || preview.problem !== null || !paymentsValid) return;
    if (nonCash > payable) {
      setMessage("UPI and card together are more than the bill.");
      return;
    }
    if (unpaid > 0) {
      setMessage("Not fully paid. Offline bills must be fully paid (no credit offline).");
      return;
    }
    const db = await existingTillDb();
    if (db === null) return;
    // IMEI items: the number must be in stock here and not sold on this till.
    for (const l of lines) {
      if (!l.item.trackSerial) continue;
      const serial = l.serial.trim().toUpperCase();
      const known = serial === "" ? undefined : await db.serials.get(serial);
      if (known?.variantId !== l.item.variantId || known.soldHere) {
        setMessage(`IMEI for ${l.item.name}: enter a number in stock at this branch.`);
        return;
      }
    }
    const payments = [
      ...(cashKept > 0 ? [{ method: "cash" as const, amountPaise: cashKept, reference: null }] : []),
      ...(cardPaise > 0 ? [{ method: "card" as const, amountPaise: cardPaise, reference: reference.trim() === "" ? null : reference.trim() }] : []),
      ...(upiPaise > 0 ? [{ method: "upi" as const, amountPaise: upiPaise, reference: reference.trim() === "" ? null : reference.trim() }] : []),
    ];
    setSaving(true);
    try {
      const at = new Date();
      const saved = await saveOfflineSale(db, {
        at,
        madeBy: session.userId,
        lines: lines.map((l) => ({ item: l.item, quantity: l.quantity.trim(), discountPaise: paiseOf(l.discount) ?? 0, serial: l.item.trackSerial ? l.serial.trim() : null })),
        billDiscountPaise: paiseOf(billDiscount) ?? 0,
        payments,
      });
      props.onSaved({
        kind: "bill",
        number: saved.number,
        at,
        lines: lines.map((l, i) => ({ name: l.item.trackSerial ? `${l.item.name} (IMEI ${l.serial.trim()})` : l.item.name, quantity: l.quantity.trim(), amountPaise: preview.bill?.lines[i]?.totalPaise ?? 0 })),
        bill: preview.bill,
        refundPaise: 0,
        payments,
        changePaise: Math.max(0, change),
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The bill could not be saved on this computer.");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const keys = (event: KeyboardEvent): void => {
      if (event.key === "F2") {
        event.preventDefault();
        scanRef.current?.focus();
      } else if (event.key === "F9") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", keys);
    return () => {
      window.removeEventListener("keydown", keys);
    };
  });

  const bill = preview.bill;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <section className="flex flex-col gap-3" aria-label="Offline cart">
        <form
          className="flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void scan();
          }}
        >
          <Label htmlFor="offline-scan">Scan a barcode, or type a SKU or name (F2)</Label>
          <div className="flex gap-2">
            <Input id="offline-scan" ref={scanRef} value={code} onChange={(e) => { setCode(e.target.value); }} autoFocus autoComplete="off" maxLength={100} />
            <Button type="submit" variant="outline">
              Add
            </Button>
          </div>
        </form>
        {hits.length > 0 ? (
          <ul className="flex flex-col divide-y rounded-lg border" aria-label="Search results">
            {hits.map((h) => (
              <li key={h.variantId}>
                <button type="button" className="w-full p-2 text-left text-sm hover:bg-muted" onClick={() => { addItem(h); }}>
                  {h.name} <span className="text-muted-foreground">{h.sku}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {message !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        ) : null}
        {lines.length === 0 ? <p className="text-sm text-muted-foreground">The cart is empty.</p> : null}
        {lines.length > 0 ? (
          <div className="table-scroll"><table className="w-full text-sm" aria-label="Cart lines">
            <thead className="border-b text-left">
              <tr>
                <th className="p-1 font-medium">Item</th>
                <th className="p-1 font-medium">Qty</th>
                <th className="p-1 font-medium">Discount ₹</th>
                <th className="p-1 text-right font-medium">Amount</th>
                <th className="p-1" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.map((l, i) => (
                <tr key={l.key} aria-label={l.item.name}>
                  <td className="p-1">
                    {l.item.name}
                    <div className="text-xs text-muted-foreground">
                      {l.item.sku} · {formatPaise(l.item.pricePaise)} · {preview.rates[i]?.label ?? ""}
                    </div>
                    {l.item.trackSerial ? <Input aria-label={`IMEI for ${l.item.name}`} placeholder="IMEI / serial" value={l.serial} onChange={(e) => { update(l.key, { serial: e.target.value }); }} className="mt-1 h-7 w-48" maxLength={40} /> : null}
                  </td>
                  <td className="p-1">
                    <Input aria-label={`Quantity of ${l.item.name}`} value={l.quantity} onChange={(e) => { update(l.key, { quantity: e.target.value }); }} disabled={l.item.trackSerial} className="h-7 w-20" maxLength={16} />
                  </td>
                  <td className="p-1">
                    <Input aria-label={`Discount on ${l.item.name}`} value={l.discount} onChange={(e) => { update(l.key, { discount: e.target.value }); }} inputMode="decimal" className="h-7 w-24" maxLength={16} />
                  </td>
                  <td className="p-1 text-right tabular-nums">{bill?.lines[i] === undefined ? "–" : formatPaise(bill.lines[i].totalPaise)}</td>
                  <td className="p-1 text-right">
                    <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${l.item.name}`} onClick={() => { setLines(lines.filter((x) => x.key !== l.key)); }}>
                      ✕
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ) : null}
      </section>

      <aside className="flex flex-col gap-3 rounded-lg border p-3" aria-label="Payment">
        <p className="text-xs text-muted-foreground">Offline: walk-in customer only, fully paid (no credit).</p>
        <div className="flex flex-col gap-1">
          <Label htmlFor="offline-bill-discount">Discount on the whole bill (₹)</Label>
          <Input id="offline-bill-discount" value={billDiscount} onChange={(e) => { setBillDiscount(e.target.value); }} inputMode="decimal" maxLength={16} />
        </div>
        <dl className="grid grid-cols-2 gap-1 text-sm" aria-label="Bill totals">
          <dt>Items</dt>
          <dd className="text-right tabular-nums">{formatPaise(bill?.grossPaise ?? 0)}</dd>
          <dt>Discount</dt>
          <dd className="text-right tabular-nums">{formatPaise(bill?.discountPaise ?? 0)}</dd>
          {settings.chargesGst ? (
            <>
              <dt>GST {settings.pricesIncludeTax ? "included" : "added"}</dt>
              <dd className="text-right tabular-nums">{formatPaise(bill?.taxPaise ?? 0)}</dd>
            </>
          ) : null}
          <dt>Round off</dt>
          <dd className="text-right tabular-nums">{formatPaise(bill?.roundOffPaise ?? 0)}</dd>
          <dt className="text-lg font-semibold">To pay</dt>
          <dd className="text-right text-lg font-semibold tabular-nums">{formatPaise(payable)}</dd>
        </dl>
        {preview.problem !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {preview.problem}
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="offline-cash">Cash received (₹)</Label>
            <Input id="offline-cash" value={cash} onChange={(e) => { setCash(e.target.value); }} inputMode="decimal" maxLength={16} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="offline-upi">UPI (₹)</Label>
            <Input id="offline-upi" value={upi} onChange={(e) => { setUpi(e.target.value); }} inputMode="decimal" maxLength={16} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="offline-card">Card (₹)</Label>
            <Input id="offline-card" value={card} onChange={(e) => { setCard(e.target.value); }} inputMode="decimal" maxLength={16} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="offline-reference">UPI / card reference</Label>
            <Input id="offline-reference" value={reference} onChange={(e) => { setReference(e.target.value); }} maxLength={100} />
          </div>
        </div>
        {!paymentsValid ? (
          <p role="alert" className="text-sm text-destructive">
            Enter payments in rupees, e.g. 500 or 499.50.
          </p>
        ) : null}
        <dl className="grid grid-cols-2 gap-1 text-sm" aria-label="Payment summary">
          <dt>Change to give</dt>
          <dd className="text-right tabular-nums">{formatPaise(Math.max(0, change))}</dd>
          <dt>Still to pay</dt>
          <dd className="text-right tabular-nums">{formatPaise(Math.max(0, unpaid))}</dd>
        </dl>
        <Button type="button" onClick={() => void save()} disabled={saving || bill === null || preview.problem !== null || !paymentsValid}>
          {saving ? "Saving…" : "Save bill offline (F9)"}
        </Button>
      </aside>
    </div>
  );
}

function OfflineReturn(props: { readiness: Extract<OfflineReadiness, { ok: true }>; onSaved: (r: Receipt) => void }): ReactNode {
  const { settings, session } = props.readiness;
  const bills = useTillQuery(keptBills, []);
  const [search, setSearch] = useState("");
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [damaged, setDamaged] = useState<Record<string, boolean>>({});
  const [method, setMethod] = useState<"cash" | "upi" | "card">("cash");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const chosen = bills.find((b) => b.invoiceId === chosenId) ?? null;
  const today = dayIn(new Date(), settings.timeZone);
  const daysSince = chosen === null ? 0 : Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${chosen.invoiceDate}T00:00:00Z`)) / 86_400_000);
  const windowPassed = chosen !== null && daysSince > settings.returnWindowDays && !session.mayReturnAfterWindow;
  const shown = bills.filter((b) => search.trim() === "" || b.number.toLowerCase().includes(search.trim().toLowerCase()));

  const picked = ((): { lines: { line: KeptBillRow["lines"][number]; quantity: string }[]; problem: string | null; refundPaise: number } => {
    if (chosen === null) return { lines: [], problem: null, refundPaise: 0 };
    const lines = chosen.lines.flatMap((line) => {
      const text = (quantities[line.invoiceItemId] ?? "").trim();
      return text === "" || text === "0" ? [] : [{ line, quantity: text }];
    });
    for (const l of lines) {
      if (!/^\d{1,11}(\.\d{1,3})?$/.test(l.quantity)) return { lines: [], problem: "Enter quantities as numbers.", refundPaise: 0 };
      if (quantityToMilli(l.quantity) + quantityToMilli(l.line.returned) > quantityToMilli(l.line.sold)) return { lines: [], problem: `That is more than was sold (${l.line.name}).`, refundPaise: 0 };
    }
    return { lines, problem: null, refundPaise: lines.length === 0 ? 0 : refundFor(lines).refundPaise };
  })();

  const save = async (): Promise<void> => {
    if (chosen === null || saving || picked.problem !== null || picked.lines.length === 0) return;
    if (reason.trim().length < 3) {
      setMessage("Say why the items came back.");
      return;
    }
    const db = await existingTillDb();
    if (db === null) return;
    setSaving(true);
    try {
      const at = new Date();
      const saved = await saveOfflineReturn(db, {
        at,
        madeBy: session.userId,
        invoiceId: chosen.invoiceId,
        lines: picked.lines.map((l) => ({ invoiceItemId: l.line.invoiceItemId, quantity: l.quantity, resellable: damaged[l.line.invoiceItemId] !== true })),
        refundMethod: method,
        reason: reason.trim(),
      });
      props.onSaved({
        kind: "credit_note",
        number: saved.number,
        at,
        lines: picked.lines.map((l) => ({ name: `${l.line.name} (bill ${chosen.number})`, quantity: l.quantity, amountPaise: 0 })),
        bill: null,
        refundPaise: saved.refundPaise,
        payments: [{ method, amountPaise: saved.refundPaise }],
        changePaise: 0,
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The return could not be saved on this computer.");
    } finally {
      setSaving(false);
    }
  };

  if (chosen === null) {
    return (
      <section className="flex flex-col gap-2" aria-label="Bills on this till">
        <Label htmlFor="offline-bill-search">Bill number (only bills made on this till in the last {settings.returnWindowDays} days)</Label>
        <Input id="offline-bill-search" value={search} onChange={(e) => { setSearch(e.target.value); }} maxLength={20} className="max-w-xs" />
        {shown.length === 0 ? <p className="text-sm text-muted-foreground">No bills kept on this till. Other returns need the internet.</p> : null}
        <ul className="flex flex-col divide-y rounded-lg border">
          {shown.slice(0, 50).map((b) => (
            <li key={b.invoiceId}>
              <button
                type="button"
                className="flex w-full justify-between gap-4 p-2 text-left text-sm hover:bg-muted"
                onClick={() => {
                  setChosenId(b.invoiceId);
                  setQuantities({});
                  setDamaged({});
                  setMessage(null);
                }}
              >
                <span>
                  {b.number} · {b.invoiceDate}
                  {b.pending ? " · pending sync" : ""}
                </span>
                <span className="tabular-nums">{formatPaise(b.payablePaise)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section className="flex max-w-2xl flex-col gap-3" aria-label="Offline return">
      <p className="text-sm">
        Bill <strong>{chosen.number}</strong> of {chosen.invoiceDate}{" "}
        <Button type="button" variant="ghost" size="sm" onClick={() => { setChosenId(null); }}>
          Choose another bill
        </Button>
      </p>
      {windowPassed ? (
        <p role="alert" className="text-sm text-destructive">
          The return period ({settings.returnWindowDays} days) has passed. A manager can take this return when the till is online.
        </p>
      ) : (
        <>
          <div className="table-scroll"><table className="w-full text-sm" aria-label="Bill lines">
            <thead className="border-b text-left">
              <tr>
                <th className="p-1 font-medium">Item</th>
                <th className="p-1 font-medium">Can return</th>
                <th className="p-1 font-medium">Return</th>
                <th className="p-1 font-medium">Damaged</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {chosen.lines.map((l) => (
                <tr key={l.invoiceItemId}>
                  <td className="p-1">
                    {l.name}
                    {l.serial === null ? "" : ` (IMEI ${l.serial})`}
                  </td>
                  <td className="p-1 tabular-nums">{formatQuantity(milliText(quantityToMilli(l.sold) - quantityToMilli(l.returned)))}</td>
                  <td className="p-1">
                    <Input aria-label={`Return quantity of ${l.name}`} value={quantities[l.invoiceItemId] ?? ""} onChange={(e) => { setQuantities({ ...quantities, [l.invoiceItemId]: e.target.value }); }} className="h-7 w-20" maxLength={16} />
                  </td>
                  <td className="p-1">
                    <input type="checkbox" aria-label={`${l.name} is damaged`} checked={damaged[l.invoiceItemId] === true} onChange={(e) => { setDamaged({ ...damaged, [l.invoiceItemId]: e.target.checked }); }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="offline-refund-method">Money back by</Label>
              <select id="offline-refund-method" value={method} onChange={(e) => { setMethod(e.target.value === "upi" ? "upi" : e.target.value === "card" ? "card" : "cash"); }} className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm">
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="card">Card</option>
              </select>
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="offline-return-reason">Reason</Label>
              <Input id="offline-return-reason" value={reason} onChange={(e) => { setReason(e.target.value); }} maxLength={500} />
            </div>
          </div>
          <p className="text-lg font-semibold">Refund {formatPaise(picked.refundPaise)}</p>
          {picked.problem !== null || message !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {picked.problem ?? message}
            </p>
          ) : null}
          <Button type="button" onClick={() => void save()} disabled={saving || picked.lines.length === 0 || picked.problem !== null} className="self-start">
            {saving ? "Saving…" : "Save return offline"}
          </Button>
        </>
      )}
    </section>
  );
}

function ReceiptView(props: { receipt: Receipt; readiness: Extract<OfflineReadiness, { ok: true }>; onNext: () => void }): ReactNode {
  const { receipt } = props;
  const { settings, till } = props.readiness;
  const next = useCallback(() => {
    props.onNext();
  }, [props]);
  return (
    <section className="flex max-w-md flex-col gap-3" aria-label={receipt.kind === "bill" ? "Offline bill" : "Offline credit note"}>
      <p className="self-start rounded border-2 border-amber-600 px-2 py-0.5 text-sm font-bold tracking-wide text-amber-700" role="status">
        PENDING SYNC
      </p>
      <div className="text-sm">
        <p className="font-semibold">{settings.businessName}</p>
        {settings.sellerAddress === null ? null : <p>{settings.sellerAddress}</p>}
        {settings.gstin === null ? null : <p>GSTIN {settings.gstin}</p>}
      </div>
      <h2 className="text-lg font-semibold">
        {receipt.kind === "bill" ? (settings.chargesGst ? "Tax invoice" : "Bill of supply") : "Credit note"} {receipt.number}
      </h2>
      <p className="text-sm text-muted-foreground">
        {receipt.at.toLocaleString("en-IN", { timeZone: settings.timeZone })} · {till.name}
      </p>
      <div className="table-scroll"><table className="w-full text-sm" aria-label="Receipt lines">
        <tbody className="divide-y">
          {receipt.lines.map((l, i) => (
            <tr key={`${l.name}-${String(i)}`}>
              <td className="p-1">{l.name}</td>
              <td className="p-1 tabular-nums">× {formatQuantity(l.quantity)}</td>
              <td className="p-1 text-right tabular-nums">{receipt.kind === "bill" ? formatPaise(l.amountPaise) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {receipt.bill !== null ? (
        <dl className="grid grid-cols-2 gap-1 text-sm" aria-label="Receipt totals">
          {settings.chargesGst ? (
            <>
              <dt>Taxable value</dt>
              <dd className="text-right tabular-nums">{formatPaise(receipt.bill.taxablePaise)}</dd>
              <dt>CGST</dt>
              <dd className="text-right tabular-nums">{formatPaise(receipt.bill.cgstPaise)}</dd>
              <dt>SGST</dt>
              <dd className="text-right tabular-nums">{formatPaise(receipt.bill.sgstPaise)}</dd>
            </>
          ) : null}
          <dt>Round off</dt>
          <dd className="text-right tabular-nums">{formatPaise(receipt.bill.roundOffPaise)}</dd>
          <dt className="font-semibold">Total</dt>
          <dd className="text-right font-semibold tabular-nums">{formatPaise(receipt.bill.payablePaise)}</dd>
          {receipt.payments.map((p) => (
            <span key={p.method} className="contents">
              <dt className="capitalize">{p.method}</dt>
              <dd className="text-right tabular-nums">{formatPaise(p.amountPaise)}</dd>
            </span>
          ))}
          <dt>Change</dt>
          <dd className="text-right tabular-nums">{formatPaise(receipt.changePaise)}</dd>
        </dl>
      ) : (
        <p className="text-sm font-semibold">
          Refund {formatPaise(receipt.refundPaise)} by {receipt.payments[0]?.method ?? "cash"}
        </p>
      )}
      <p className="text-xs text-muted-foreground">Saved on this till. It will be sent to the business when the internet is back.</p>
      <div className="flex gap-2 print:hidden">
        <Button type="button" variant="outline" onClick={() => { window.print(); }}>
          Print
        </Button>
        <Button type="button" onClick={next}>
          {receipt.kind === "bill" ? "Next bill" : "Done"}
        </Button>
      </div>
    </section>
  );
}
