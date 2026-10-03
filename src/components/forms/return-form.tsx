"use client";

import { useActionState, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPaise } from "@/lib/money";
import { formatQuantity } from "@/lib/quantity";
import type { ReturnableDto } from "@/modules/sales";
import { EMPTY, Result, selectClass, useKeptForm, type BranchChoice, type FormAction } from "./stock-forms";

// Choosing what comes back on a bill. The server checks every quantity
// again (never more than sold, earlier returns count) and works out the
// refund from the bill's own lines.
export function ReturnForm(props: { bill: ReturnableDto; branches: BranchChoice[]; creditNoteId: string; idempotencyKey: string; save: FormAction }): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  const formRef = useRef<HTMLFormElement>(null);
  const onSubmit = useKeptForm(state, action, formRef);
  const open = props.bill.lines.filter((l) => l.remaining !== "0.000");
  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4">
      <input type="hidden" name="invoiceId" value={props.bill.invoiceId} />
      <input type="hidden" name="creditNoteId" value={props.creditNoteId} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <table className="w-full text-sm" aria-label="Returnable items">
        <thead className="border-b text-left">
          <tr>
            <th className="p-1 font-medium">Item</th>
            <th className="p-1 text-right font-medium">Sold</th>
            <th className="p-1 text-right font-medium">Already back</th>
            <th className="p-1 font-medium">Return now</th>
            <th className="p-1 font-medium">Can be sold again</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {open.map((l) => (
            <tr key={l.invoiceItemId} aria-label={l.name}>
              <td className="p-1">
                {l.name}
                <span className="block text-xs text-muted-foreground">
                  {l.sku}
                  {l.serial === null ? "" : ` · IMEI ${l.serial}`} · line {formatPaise(l.totalPaise)}
                </span>
              </td>
              <td className="p-1 text-right tabular-nums">{formatQuantity(l.sold)}</td>
              <td className="p-1 text-right tabular-nums">{formatQuantity(l.returned)}</td>
              <td className="p-1">
                {l.serial === null ? (
                  <Input aria-label={`Return quantity of ${l.name}`} name={`qty-${l.invoiceItemId}`} inputMode="decimal" placeholder={`up to ${formatQuantity(l.remaining)}`} className="h-7 w-28" maxLength={16} />
                ) : (
                  <label className="flex items-center gap-1">
                    <input type="checkbox" name={`qty-${l.invoiceItemId}`} value="1" aria-label={`Return ${l.name}`} /> this phone
                  </label>
                )}
              </td>
              <td className="p-1">
                <input type="checkbox" name={`resellable-${l.invoiceItemId}`} defaultChecked aria-label={`${l.name} can be sold again`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {open.length === 0 ? <p className="text-sm text-muted-foreground">Everything on this bill has already been returned.</p> : null}
      <div className="flex flex-wrap gap-3">
        {props.branches.length > 1 ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="return-branch">Back into branch</Label>
            <select id="return-branch" name="branchId" defaultValue={props.branches[0]?.id} className={selectClass}>
              {props.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <input type="hidden" name="branchId" value={props.branches[0]?.id ?? ""} />
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor="refundMethod">Money goes back as</Label>
          <select id="refundMethod" name="refundMethod" required defaultValue="cash" className={selectClass}>
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            <option value="card">Card</option>
            {props.bill.customerId === null ? null : <option value="store_credit">Store credit (on {props.bill.buyerName ?? "the customer"}&apos;s account)</option>}
          </select>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="reason">Reason</Label>
          <Input id="reason" name="reason" required minLength={3} maxLength={500} placeholder="e.g. wrong size" />
        </div>
      </div>
      <Result state={state} />
      <Button type="submit" disabled={pending || open.length === 0} className="self-start">
        Save return
      </Button>
    </form>
  );
}
