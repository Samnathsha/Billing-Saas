"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BillMathError, computeBill, discountWithinLimit, type BillResult } from "@/lib/bill-maths";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";
import type { CustomerDto } from "@/modules/parties";
import type { PosItemDto, PosSetupDto } from "@/modules/sales";

// The till. Totals here are a preview with the same maths as the server
// (src/lib/bill-maths); the server recomputes the sale and refuses it if
// its total differs from the one shown. Scanners type the code and press
// Enter. Keys: F2 = scan box, F9 = save. A held cart stays on this computer.

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface PosActions {
  priceItems: (input: { branchId: string; codes?: string[]; variantIds?: string[] }) => Promise<Result<[string, PosItemDto][]>>;
  searchItems: (q: string) => Promise<Result<{ variantId: string; name: string; sku: string }[]>>;
  findCustomers: (q: string) => Promise<Result<CustomerDto[]>>;
  addCustomer: (input: { name: string; phone: string }) => Promise<Result<CustomerDto>>;
  sale: (input: unknown) => Promise<Result<{ invoiceId: string }>>;
}

interface Line {
  key: string;
  item: PosItemDto;
  quantity: string;
  discount: string; // rupees as typed
  serial: string;
}

interface Cart {
  lines: Line[];
  billDiscount: string;
  customer: CustomerDto | null;
  card: string;
  upi: string;
  reference: string;
  cashReceived: string;
}

const EMPTY_CART: Cart = { lines: [], billDiscount: "", customer: null, card: "", upi: "", reference: "", cashReceived: "" };
const HELD_KEY = "pos-held-carts";

// Typed rupees -> paise; empty = 0; a typing mistake = null.
const paiseOf = (text: string): number | null => (text.trim() === "" ? 0 : rupeesToPaise(text));

// Held bills live in this browser only (per till). Read through React's
// external-store hook so every tab and render agrees; a private window or
// blocked storage simply holds nothing.
const HELD_EVENT = "pos-held-changed";

function readHeldRaw(): string {
  try {
    return window.localStorage.getItem(HELD_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function subscribeHeld(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(HELD_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(HELD_EVENT, onChange);
  };
}

function parseHeld(raw: string): { at: string; cart: Cart }[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? (value as { at: string; cart: Cart }[]) : [];
  } catch {
    return [];
  }
}

function writeHeld(held: { at: string; cart: Cart }[]): void {
  try {
    window.localStorage.setItem(HELD_KEY, JSON.stringify(held));
  } catch {
    // Storage blocked: holding just does not persist.
  }
  window.dispatchEvent(new Event(HELD_EVENT));
}

// tillId: this computer's registered till, recorded on the bill so the till
// can take it back offline later (decision 0006).
export function PosScreen(props: { setup: PosSetupDto; branches: { id: string; name: string }[]; actions: PosActions; tillId?: string | null }): ReactNode {
  const { setup, actions } = props;
  const router = useRouter();
  const [branchId, setBranchId] = useState(props.branches[0]?.id ?? "");
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [ids, setIds] = useState(() => ({ invoiceId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }));
  const [code, setCode] = useState("");
  const [hits, setHits] = useState<{ variantId: string; name: string; sku: string }[]>([]);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerHits, setCustomerHits] = useState<CustomerDto[]>([]);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const heldRaw = useSyncExternalStore(subscribeHeld, readHeldRaw, () => "[]");
  const held = useMemo(() => parseHeld(heldRaw), [heldRaw]);
  const [pending, startTransition] = useTransition();
  const scanRef = useRef<HTMLInputElement>(null);

  // The bill as the server will see it (preview).
  const preview = useMemo((): { bill: BillResult | null; problem: string | null } => {
    if (cart.lines.length === 0) return { bill: null, problem: null };
    const discounts = cart.lines.map((l) => paiseOf(l.discount));
    const billDiscount = paiseOf(cart.billDiscount);
    if (discounts.some((d) => d === null) || billDiscount === null) return { bill: null, problem: "Enter discounts in rupees, e.g. 50 or 49.50." };
    try {
      const bill = computeBill({
        lines: cart.lines.map((l, i) => ({ quantity: l.quantity.trim(), unitPricePaise: l.item.pricePaise, taxRate: l.item.taxRate, discountPaise: discounts[i] ?? 0 })),
        pricesIncludeTax: setup.pricesIncludeTax,
        chargesGst: setup.chargesGst,
        interState: cart.customer !== null && cart.customer.gstin !== null && cart.customer.stateCode !== null && cart.customer.stateCode !== setup.stateCode,
        billDiscountPaise: billDiscount,
        roundOff: true,
      });
      if (!discountWithinLimit(bill, setup.discountLimitBps)) return { bill, problem: "This discount is above your limit. Ask a manager." };
      return { bill, problem: null };
    } catch (error) {
      return { bill: null, problem: error instanceof BillMathError ? error.message : "Please check the bill." };
    }
  }, [cart, setup]);

  const payable = preview.bill?.payablePaise ?? 0;
  const card = paiseOf(cart.card);
  const upi = paiseOf(cart.upi);
  const cashReceived = paiseOf(cart.cashReceived);
  const paymentsValid = card !== null && upi !== null && cashReceived !== null;
  const nonCash = (card ?? 0) + (upi ?? 0);
  const cashKept = Math.max(0, Math.min(cashReceived ?? 0, payable - nonCash));
  const change = (cashReceived ?? 0) - cashKept;
  const onCredit = payable - nonCash - cashKept;

  const update = (change: Partial<Cart>) => {
    setCart((c) => ({ ...c, ...change }));
  };
  const updateLine = (key: string, change: Partial<Line>) => {
    setCart((c) => ({ ...c, lines: c.lines.map((l) => (l.key === key ? { ...l, ...change } : l)) }));
  };

  const addItem = (item: PosItemDto) => {
    setCart((c) => {
      // Same plain item again: one more on its line. IMEI items: a line each.
      const same = item.trackSerial ? undefined : c.lines.find((l) => l.item.variantId === item.variantId);
      if (same !== undefined && /^\d+$/.test(same.quantity)) {
        return { ...c, lines: c.lines.map((l) => (l === same ? { ...l, quantity: String(Number(l.quantity) + 1) } : l)) };
      }
      return { ...c, lines: [...c.lines, { key: crypto.randomUUID(), item, quantity: "1", discount: "", serial: "" }] };
    });
    setHits([]);
    setCode("");
    setMessage(null);
  };

  const scan = (text: string) => {
    const value = text.trim();
    if (value === "") return;
    startTransition(async () => {
      if (/^[A-Za-z0-9._/-]{1,64}$/.test(value)) {
        const priced = await actions.priceItems({ branchId, codes: [value] });
        if (!priced.ok) {
        setMessage({ kind: "error", text: priced.error });
        return;
      }
        const found = priced.value[0];
        if (found !== undefined) {
          addItem(found[1]);
          return;
        }
      }
      const found = await actions.searchItems(value);
      if (!found.ok) {
        setMessage({ kind: "error", text: found.error });
        return;
      }
      setHits(found.value);
      setMessage(found.value.length === 0 ? { kind: "error", text: `Nothing found for "${value}".` } : null);
    });
  };

  const pick = (variantId: string) => {
    startTransition(async () => {
      const priced = await actions.priceItems({ branchId, variantIds: [variantId] });
      if (!priced.ok) {
        setMessage({ kind: "error", text: priced.error });
        return;
      }
      const found = priced.value[0];
      if (found === undefined) {
        setMessage({ kind: "error", text: "This item cannot be sold (archived, or no GST rate)." });
        return;
      }
      addItem(found[1]);
    });
  };

  const searchCustomers = () => {
    startTransition(async () => {
      const found = await actions.findCustomers(customerQuery);
      if (!found.ok) {
        setMessage({ kind: "error", text: found.error });
        return;
      }
      setCustomerHits(found.value);
      if (found.value.length === 0) setMessage({ kind: "info", text: "No customer found. Add one below." });
    });
  };

  const addCustomer = (form: FormData) => {
    const field = (key: string): string => {
      const value = form.get(key);
      return typeof value === "string" ? value : "";
    };
    const name = field("customerName");
    const phone = field("customerPhone");
    startTransition(async () => {
      const created = await actions.addCustomer({ name, phone });
      if (!created.ok) {
        setMessage({ kind: "error", text: created.error });
        return;
      }
      update({ customer: created.value });
      setCustomerHits([]);
      setMessage(null);
    });
  };

  const hold = () => {
    if (cart.lines.length === 0) return;
    const next = [...held, { at: new Date().toLocaleTimeString("en-IN"), cart }];
    writeHeld(next);
    setCart(EMPTY_CART);
    setIds({ invoiceId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() });
  };

  const resume = (index: number) => {
    const entry = held[index];
    if (entry === undefined) return;
    const next = held.filter((_, i) => i !== index);
    writeHeld(next);
    setCart(entry.cart);
    setIds({ invoiceId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() });
  };

  const save = () => {
    if (preview.bill === null || preview.problem !== null || !paymentsValid || pending) return;
    if (onCredit > 0 && cart.customer === null) {
      setMessage({ kind: "error", text: "Not fully paid: choose a customer to put the rest on their account." });
      return;
    }
    const payments = [
      ...(cashKept > 0 ? [{ method: "cash", amountPaise: cashKept }] : []),
      ...(card > 0 ? [{ method: "card", amountPaise: card, reference: cart.reference }] : []),
      ...(upi > 0 ? [{ method: "upi", amountPaise: upi, reference: cart.reference }] : []),
    ];
    const input = {
      ...ids,
      branchId,
      tillId: props.tillId ?? null,
      customerId: cart.customer?.id ?? null,
      lines: cart.lines.map((l) => ({ variantId: l.item.variantId, quantity: l.quantity.trim(), discountPaise: paiseOf(l.discount) ?? 0, serial: l.item.trackSerial ? l.serial.trim() : null })),
      billDiscountPaise: paiseOf(cart.billDiscount) ?? 0,
      payments,
      expectedPayablePaise: preview.bill.payablePaise,
    };
    startTransition(async () => {
      const result = await actions.sale(input);
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setCart(EMPTY_CART);
      setIds({ invoiceId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() });
      router.push(`/sales/${result.value.invoiceId}?saved=1`);
    });
  };

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === "F2") {
        event.preventDefault();
        scanRef.current?.focus();
      } else if (event.key === "F9") {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", keys);
    return () => {
      window.removeEventListener("keydown", keys);
    };
  });

  if (!setup.ready) {
    return <p className="text-sm">Set the business&apos;s state and GST registration in Business settings before billing.</p>;
  }

  const bill = preview.bill;
  // Why "Save bill" cannot be pressed yet, in words (other reasons already
  // show as red messages above it).
  const needsCustomer = onCredit > 0 && cart.customer === null;
  const saveHint =
    cart.lines.length === 0
      ? "Add an item to start a bill."
      : needsCustomer && paymentsValid && preview.problem === null
        ? "Part of this bill is unpaid. Take the full amount, or choose a customer to put the rest on their account."
        : null;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <section className="flex flex-col gap-3" aria-label="Cart">
        <div className="flex flex-wrap items-end gap-2">
          {props.branches.length > 1 ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="pos-branch">Branch</Label>
              <select id="pos-branch" value={branchId} onChange={(e) => { setBranchId(e.target.value); }} className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm" disabled={cart.lines.length > 0}>
                {props.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <form
            className="flex flex-1 flex-col gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              scan(code);
            }}
          >
            <Label htmlFor="pos-scan">Scan a barcode, or type a SKU or name (F2)</Label>
            <div className="flex gap-2">
              <Input id="pos-scan" ref={scanRef} value={code} onChange={(e) => { setCode(e.target.value); }} autoFocus autoComplete="off" maxLength={100} />
              <Button type="submit" variant="outline" disabled={pending}>
                Add
              </Button>
            </div>
          </form>
        </div>
        {hits.length > 0 ? (
          <ul className="flex flex-col divide-y rounded-lg border" aria-label="Search results">
            {hits.map((h) => (
              <li key={h.variantId}>
                <button type="button" className="w-full p-2 text-left text-sm hover:bg-muted" onClick={() => { pick(h.variantId); }}>
                  {h.name} <span className="text-muted-foreground">{h.sku}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {message !== null ? (
          <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {message.text}
          </p>
        ) : null}
        {cart.lines.length === 0 ? <p className="text-sm text-muted-foreground">The cart is empty.</p> : null}
        {cart.lines.length > 0 ? (
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
              {cart.lines.map((l, i) => (
                <tr key={l.key} aria-label={l.item.name}>
                  <td className="min-w-44 p-1">
                    {l.item.name}
                    <div className="text-xs text-muted-foreground">
                      {l.item.sku} · {formatPaise(l.item.pricePaise)} · {l.item.taxLabel} · in stock {formatQuantity(l.item.inStock)}
                    </div>
                    {l.item.trackSerial ? (
                      <Input aria-label={`IMEI for ${l.item.name}`} placeholder="IMEI / serial" value={l.serial} onChange={(e) => { updateLine(l.key, { serial: e.target.value }); }} className="mt-1 h-9 w-48" maxLength={40} />
                    ) : null}
                  </td>
                  <td className="p-1">
                    <Input aria-label={`Quantity of ${l.item.name}`} value={l.quantity} onChange={(e) => { updateLine(l.key, { quantity: e.target.value }); }} disabled={l.item.trackSerial} inputMode={l.item.allowsFraction ? "decimal" : "numeric"} className="h-9 w-20" maxLength={16} />
                  </td>
                  <td className="p-1">
                    <Input aria-label={`Discount on ${l.item.name}`} value={l.discount} onChange={(e) => { updateLine(l.key, { discount: e.target.value }); }} inputMode="decimal" className="h-9 w-24" maxLength={16} />
                  </td>
                  <td className="p-1 text-right tabular-nums">{bill?.lines[i] === undefined ? "–" : formatPaise(bill.lines[i].totalPaise)}</td>
                  <td className="p-1 text-right">
                    <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${l.item.name}`} onClick={() => { update({ lines: cart.lines.filter((x) => x.key !== l.key) }); }}>
                      ✕
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={hold} disabled={cart.lines.length === 0}>
            Hold this bill
          </Button>
          {held.map((h, i) => (
            <Button key={`${h.at}-${String(i)}`} type="button" variant="outline" size="sm" onClick={() => { resume(i); }} disabled={cart.lines.length > 0}>
              Resume ({h.cart.lines.length} items, {h.at})
            </Button>
          ))}
        </div>
      </section>

      <aside className="flex flex-col gap-3 rounded-lg border p-3" aria-label="Payment">
        <section className="flex flex-col gap-1" aria-label="Customer">
          {cart.customer === null ? (
            <>
              <Label htmlFor="pos-customer">Customer (phone or name, optional)</Label>
              <div className="flex gap-2">
                <Input id="pos-customer" value={customerQuery} onChange={(e) => { setCustomerQuery(e.target.value); }} maxLength={100} />
                <Button type="button" variant="outline" size="sm" onClick={searchCustomers} disabled={pending || customerQuery.trim() === ""}>
                  Find
                </Button>
              </div>
              {customerHits.map((c) => (
                <button key={c.id} type="button" className="rounded p-1 text-left text-sm hover:bg-muted" onClick={() => { update({ customer: c }); setCustomerHits([]); }}>
                  {c.name} {c.phone ?? ""}
                </button>
              ))}
              <form action={addCustomer} className="flex flex-wrap gap-1" aria-label="New customer">
                <Input name="customerName" placeholder="New customer name" aria-label="New customer name" className="h-9 min-w-0 flex-1" maxLength={200} required />
                <Input name="customerPhone" placeholder="Phone" aria-label="New customer phone" className="h-9 w-32" maxLength={20} />
                <Button type="submit" variant="outline" size="sm" disabled={pending}>
                  Add
                </Button>
              </form>
            </>
          ) : (
            <p className="flex items-center justify-between text-sm">
              <span>
                <strong>{cart.customer.name}</strong> {cart.customer.phone ?? ""}
                {cart.customer.creditLimitPaise > 0 ? <span className="block text-xs text-muted-foreground">Owes {formatPaise(cart.customer.balancePaise)} of {formatPaise(cart.customer.creditLimitPaise)} credit</span> : null}
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={() => { update({ customer: null }); }}>
                Change
              </Button>
            </p>
          )}
        </section>

        <div className="flex flex-col gap-1">
          <Label htmlFor="pos-bill-discount">Discount on the whole bill (₹)</Label>
          <Input id="pos-bill-discount" value={cart.billDiscount} onChange={(e) => { update({ billDiscount: e.target.value }); }} inputMode="decimal" maxLength={16} />
        </div>

        <dl className="grid grid-cols-2 gap-1 text-sm" aria-label="Bill totals">
          <dt>Items</dt>
          <dd className="text-right tabular-nums">{formatPaise(bill?.grossPaise ?? 0)}</dd>
          <dt>Discount</dt>
          <dd className="text-right tabular-nums">{formatPaise(bill?.discountPaise ?? 0)}</dd>
          {setup.chargesGst ? (
            <>
              <dt>GST included</dt>
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
            <Label htmlFor="pos-cash">Cash received (₹)</Label>
            <Input id="pos-cash" value={cart.cashReceived} onChange={(e) => { update({ cashReceived: e.target.value }); }} inputMode="decimal" maxLength={16} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="pos-upi">UPI (₹)</Label>
            <Input id="pos-upi" value={cart.upi} onChange={(e) => { update({ upi: e.target.value }); }} inputMode="decimal" maxLength={16} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="pos-card">Card (₹)</Label>
            <Input id="pos-card" value={cart.card} onChange={(e) => { update({ card: e.target.value }); }} inputMode="decimal" maxLength={16} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="pos-reference">UPI / card reference</Label>
            <Input id="pos-reference" value={cart.reference} onChange={(e) => { update({ reference: e.target.value }); }} maxLength={100} />
          </div>
        </div>
        {!paymentsValid ? (
          <p role="alert" className="text-sm text-destructive">
            Enter payments in rupees, e.g. 500 or 499.50.
          </p>
        ) : null}
        {paymentsValid && nonCash > payable ? (
          <p role="alert" className="text-sm text-destructive">
            UPI and card together are more than the bill.
          </p>
        ) : null}
        <dl className="grid grid-cols-2 gap-1 text-sm" aria-label="Payment summary">
          <dt>Change to give</dt>
          <dd className="text-right tabular-nums">{formatPaise(Math.max(0, change))}</dd>
          <dt>On the customer&apos;s account</dt>
          <dd className="text-right tabular-nums">{formatPaise(Math.max(0, onCredit))}</dd>
        </dl>
        <Button
          type="button"
          size="lg"
          onClick={save}
          aria-describedby={saveHint === null ? undefined : "pos-save-hint"}
          disabled={pending || bill === null || preview.problem !== null || !paymentsValid || nonCash > payable || needsCustomer}
        >
          {pending ? "Saving…" : "Save bill (F9)"}
        </Button>
        {saveHint === null ? null : (
          <p id="pos-save-hint" className="text-sm text-muted-foreground">
            {saveHint}
          </p>
        )}
      </aside>
    </div>
  );
}
