"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BillMathError, computeBill, discountWithinLimit, quantityToMilli } from "@/lib/bill-maths";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";
import { returnAmounts } from "@/lib/return-maths";
import type { PosItemDto, PosSetupDto, ReturnableDto } from "@/modules/sales";

// An exchange: items back from a bill, new items out, one save. The returned
// value pays the new bill first; the screen shows the difference to pay or
// to give back. Previews use the same maths as the server, which recomputes
// everything and refuses a different total.

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ExchangeActions {
  priceItems: (input: { branchId: string; codes?: string[]; variantIds?: string[] }) => Promise<Result<[string, PosItemDto][]>>;
  exchange: (input: unknown) => Promise<Result<{ invoiceId: string; creditNoteId: string }>>;
}

interface NewLine {
  key: string;
  item: PosItemDto;
  quantity: string;
  serial: string;
}

const paiseOf = (text: string): number | null => (text.trim() === "" ? 0 : rupeesToPaise(text));
const QTY = /^\d{1,11}(\.\d{1,3})?$/;

export function ExchangeScreen(props: { bill: ReturnableDto; setup: PosSetupDto; branches: { id: string; name: string }[]; actions: ExchangeActions }): ReactNode {
  const { bill, setup, actions } = props;
  const router = useRouter();
  const branchId = props.branches[0]?.id ?? "";
  const [ids] = useState(() => ({ idempotencyKey: crypto.randomUUID(), creditNoteId: crypto.randomUUID(), invoiceId: crypto.randomUUID() }));
  const [back, setBack] = useState<Record<string, { quantity: string; resellable: boolean }>>({});
  const [lines, setLines] = useState<NewLine[]>([]);
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [cash, setCash] = useState("");
  const [upi, setUpi] = useState("");
  const [leftoverMethod, setLeftoverMethod] = useState("cash");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const preview = useMemo(() => {
    // Value of what comes back, exactly as the credit note will work it out.
    let returnedTotal = 0;
    let problem: string | null = null;
    for (const l of bill.lines) {
      const q = back[l.invoiceItemId]?.quantity.trim() ?? "";
      if (q === "" || q === "0") continue;
      if (!QTY.test(q)) {
        problem = "Enter return quantities with at most 3 decimals.";
        continue;
      }
      const now = quantityToMilli(q);
      const sold = quantityToMilli(l.sold);
      const already = quantityToMilli(l.returned);
      if (now === 0n) continue;
      if (already + now > sold) {
        problem = `More than was sold: ${l.name}.`;
        continue;
      }
      returnedTotal += returnAmounts(l, sold, already, now).totalPaise;
    }
    const refund = Number(((2n * BigInt(returnedTotal) + 100n) / 200n) * 100n);
    let payable = 0;
    if (lines.length > 0) {
      try {
        const result = computeBill({
          lines: lines.map((l) => ({ quantity: l.quantity.trim(), unitPricePaise: l.item.pricePaise, taxRate: l.item.taxRate, discountPaise: 0 })),
          pricesIncludeTax: setup.pricesIncludeTax,
          chargesGst: setup.chargesGst,
          interState: bill.interState,
          billDiscountPaise: 0,
          roundOff: true,
        });
        if (!discountWithinLimit(result, setup.discountLimitBps)) problem = "Discount above your limit.";
        payable = result.payablePaise;
      } catch (error) {
        problem = error instanceof BillMathError ? error.message : "Please check the new items.";
      }
    }
    const applied = Math.min(refund, payable);
    return { refund, payable, applied, toPay: payable - applied, leftover: refund - applied, problem };
  }, [back, lines, bill, setup]);

  const cashIn = paiseOf(cash);
  const upiIn = paiseOf(upi);
  const cashKept = Math.max(0, Math.min(cashIn ?? 0, preview.toPay - (upiIn ?? 0)));
  const unpaid = preview.toPay - (upiIn ?? 0) - cashKept;
  const returning = bill.lines.filter((l) => {
    const q = back[l.invoiceItemId]?.quantity.trim() ?? "";
    return q !== "" && q !== "0";
  });

  const add = (text: string) => {
    const value = text.trim();
    if (value === "") return;
    startTransition(async () => {
      const priced = await actions.priceItems({ branchId, codes: [value] });
      if (!priced.ok) {
        setMessage(priced.error);
        return;
      }
      const found = priced.value[0];
      if (found === undefined) {
        setMessage(`No item has the SKU or barcode "${value}".`);
        return;
      }
      setLines((current) => [...current, { key: crypto.randomUUID(), item: found[1], quantity: "1", serial: "" }]);
      setCode("");
      setMessage(null);
    });
  };

  const save = () => {
    if (preview.problem !== null || returning.length === 0 || lines.length === 0 || cashIn === null || upiIn === null || pending) return;
    const payments = [...(cashKept > 0 ? [{ method: "cash", amountPaise: cashKept }] : []), ...(upiIn > 0 ? [{ method: "upi", amountPaise: upiIn }] : [])];
    const input = {
      idempotencyKey: ids.idempotencyKey,
      branchId,
      return: {
        creditNoteId: ids.creditNoteId,
        invoiceId: bill.invoiceId,
        reason,
        lines: returning.map((l) => ({ invoiceItemId: l.invoiceItemId, quantity: back[l.invoiceItemId]?.quantity.trim() ?? "", resellable: back[l.invoiceItemId]?.resellable ?? true })),
      },
      sale: {
        invoiceId: ids.invoiceId,
        lines: lines.map((l) => ({ variantId: l.item.variantId, quantity: l.quantity.trim(), discountPaise: 0, serial: l.item.trackSerial ? l.serial.trim() : null })),
        payments,
        expectedPayablePaise: preview.payable,
      },
      leftoverMethod,
    };
    startTransition(async () => {
      const result = await actions.exchange(input);
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      router.push(`/sales/${result.value.invoiceId}?saved=1`);
    });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="flex flex-col gap-2" aria-label="Coming back">
        <h2 className="font-medium">1. Coming back from {bill.number}</h2>
        <table className="w-full text-sm" aria-label="Returnable items">
          <thead className="border-b text-left">
            <tr>
              <th className="p-1 font-medium">Item</th>
              <th className="p-1 text-right font-medium">Can return</th>
              <th className="p-1 font-medium">Return</th>
              <th className="p-1 font-medium">Sell again</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {bill.lines
              .filter((l) => l.remaining !== "0.000")
              .map((l) => (
                <tr key={l.invoiceItemId} aria-label={l.name}>
                  <td className="p-1">
                    {l.name}
                    {l.serial === null ? null : <span className="block text-xs text-muted-foreground">IMEI {l.serial}</span>}
                  </td>
                  <td className="p-1 text-right tabular-nums">{formatQuantity(l.remaining)}</td>
                  <td className="p-1">
                    <Input
                      aria-label={`Return quantity of ${l.name}`}
                      value={back[l.invoiceItemId]?.quantity ?? ""}
                      onChange={(e) => {
                        setBack({ ...back, [l.invoiceItemId]: { quantity: e.target.value, resellable: back[l.invoiceItemId]?.resellable ?? true } });
                      }}
                      inputMode="decimal"
                      className="h-7 w-20"
                      maxLength={16}
                    />
                  </td>
                  <td className="p-1">
                    <input
                      type="checkbox"
                      aria-label={`${l.name} can be sold again`}
                      checked={back[l.invoiceItemId]?.resellable ?? true}
                      onChange={(e) => {
                        setBack({ ...back, [l.invoiceItemId]: { quantity: back[l.invoiceItemId]?.quantity ?? "", resellable: e.target.checked } });
                      }}
                    />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        <Label htmlFor="exchange-reason">Reason</Label>
        <Input id="exchange-reason" value={reason} onChange={(e) => { setReason(e.target.value); }} maxLength={500} placeholder="e.g. wrong size" />
      </section>

      <section className="flex flex-col gap-2" aria-label="Going out">
        <h2 className="font-medium">2. New items</h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add(code);
          }}
        >
          <Input aria-label="Scan or type the new item's SKU" value={code} onChange={(e) => { setCode(e.target.value); }} maxLength={64} autoComplete="off" />
          <Button type="submit" variant="outline" disabled={pending}>
            Add
          </Button>
        </form>
        {lines.map((l) => (
          <div key={l.key} className="flex flex-wrap items-center gap-2 text-sm" aria-label={`New ${l.item.name}`}>
            <span className="flex-1">
              {l.item.name} · {formatPaise(l.item.pricePaise)}
            </span>
            <Input aria-label={`Quantity of new ${l.item.name}`} value={l.quantity} disabled={l.item.trackSerial} onChange={(e) => { setLines(lines.map((x) => (x.key === l.key ? { ...x, quantity: e.target.value } : x))); }} className="h-7 w-16" maxLength={16} />
            {l.item.trackSerial ? <Input aria-label={`IMEI for new ${l.item.name}`} placeholder="IMEI" value={l.serial} onChange={(e) => { setLines(lines.map((x) => (x.key === l.key ? { ...x, serial: e.target.value } : x))); }} className="h-7 w-40" maxLength={40} /> : null}
            <Button type="button" variant="ghost" size="sm" aria-label={`Remove new ${l.item.name}`} onClick={() => { setLines(lines.filter((x) => x.key !== l.key)); }}>
              ✕
            </Button>
          </div>
        ))}

        <h2 className="mt-2 font-medium">3. Settle the difference</h2>
        <dl className="grid grid-cols-2 gap-1 text-sm" aria-label="Exchange totals">
          <dt>Value coming back</dt>
          <dd className="text-right tabular-nums">{formatPaise(preview.refund)}</dd>
          <dt>New bill</dt>
          <dd className="text-right tabular-nums">{formatPaise(preview.payable)}</dd>
          <dt className="font-semibold">Customer pays</dt>
          <dd className="text-right font-semibold tabular-nums">{formatPaise(preview.toPay)}</dd>
          <dt className="font-semibold">Customer gets back</dt>
          <dd className="text-right font-semibold tabular-nums">{formatPaise(preview.leftover)}</dd>
        </dl>
        {preview.toPay > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="exchange-cash">Cash received (₹)</Label>
              <Input id="exchange-cash" value={cash} onChange={(e) => { setCash(e.target.value); }} inputMode="decimal" maxLength={16} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="exchange-upi">UPI (₹)</Label>
              <Input id="exchange-upi" value={upi} onChange={(e) => { setUpi(e.target.value); }} inputMode="decimal" maxLength={16} />
            </div>
          </div>
        ) : null}
        {preview.leftover > 0 ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="exchange-leftover">Give back as</Label>
            <select id="exchange-leftover" value={leftoverMethod} onChange={(e) => { setLeftoverMethod(e.target.value); }} className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm">
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="card">Card</option>
              {bill.customerId === null ? null : <option value="store_credit">Store credit</option>}
            </select>
          </div>
        ) : null}
        {preview.problem !== null ? <p role="alert" className="text-sm text-destructive">{preview.problem}</p> : null}
        {cashIn === null || upiIn === null ? <p role="alert" className="text-sm text-destructive">Enter amounts in rupees, e.g. 500 or 499.50.</p> : null}
        {unpaid > 0 && bill.customerId === null ? <p className="text-sm text-muted-foreground">Still to pay: {formatPaise(unpaid)}</p> : null}
        {message !== null ? <p role="alert" className="text-sm text-destructive">{message}</p> : null}
        <Button
          type="button"
          onClick={save}
          disabled={pending || preview.problem !== null || returning.length === 0 || lines.length === 0 || reason.trim().length < 3 || cashIn === null || upiIn === null}
        >
          {pending ? "Saving…" : "Save exchange"}
        </Button>
      </section>
    </div>
  );
}
