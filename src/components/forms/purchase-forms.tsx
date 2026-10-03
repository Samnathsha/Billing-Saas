"use client";

import { useActionState, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BranchSelect, EMPTY, Result, selectClass, type BranchChoice, type FormAction } from "./stock-forms";
import { MethodSelect } from "./supplier-forms";

const textareaClass = "min-h-14 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm";

// Entering a supplier's bill. Prices are per unit BEFORE GST, in rupees; the
// server works out every total exactly and shows them after saving.
export function NewPurchaseForm(props: {
  suppliers: { id: string; name: string }[];
  supplierId: string;
  branches: BranchChoice[];
  idempotencyKey: string;
  today: string;
  costNote: string;
  save: FormAction;
}): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  const [rows, setRows] = useState([0]);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <input type="hidden" name="rows" value={rows.join(",")} />
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="supplierId">Supplier</Label>
          <select id="supplierId" name="supplierId" required defaultValue={props.supplierId} className={selectClass}>
            <option value="">Choose a supplier</option>
            {props.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <BranchSelect branches={props.branches} />
        <div className="flex flex-col gap-1">
          <Label htmlFor="billNumber">Supplier bill number</Label>
          <Input id="billNumber" name="billNumber" required maxLength={40} className="w-44" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="billDate">Bill date</Label>
          <Input id="billDate" name="billDate" type="date" required defaultValue={props.today} max={props.today} className="w-40" />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{props.costNote}</p>
      {rows.map((row, index) => {
        const r = String(row);
        return (
          <fieldset key={row} className="flex flex-col gap-2 rounded-lg border p-3" aria-label={`Line ${String(index + 1)}`}>
            <legend className="px-1 text-sm font-medium">Line {index + 1}</legend>
            <div className="flex flex-wrap gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`code-${r}`}>SKU or barcode</Label>
                <Input id={`code-${r}`} name={`code-${r}`} required maxLength={64} className="w-44" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`qty-${r}`}>Quantity</Label>
                <Input id={`qty-${r}`} name={`qty-${r}`} required inputMode="decimal" maxLength={16} className="w-24" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`price-${r}`}>Price per unit before GST (₹)</Label>
                <Input id={`price-${r}`} name={`price-${r}`} required inputMode="decimal" maxLength={16} className="w-40" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`rate-${r}`}>GST %</Label>
                <Input id={`rate-${r}`} name={`rate-${r}`} required inputMode="decimal" maxLength={8} placeholder="e.g. 5" className="w-20" />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`serials-${r}`}>IMEI / serial numbers (IMEI items only, one per line)</Label>
              <textarea id={`serials-${r}`} name={`serials-${r}`} className={textareaClass} />
            </div>
            {rows.length > 1 ? (
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => { setRows(rows.filter((x) => x !== row)); }}>
                Remove line
              </Button>
            ) : null}
          </fieldset>
        );
      })}
      <Button type="button" variant="outline" className="self-start" onClick={() => { setRows([...rows, Math.max(...rows) + 1]); }}>
        Add a line
      </Button>
      <fieldset className="flex flex-col gap-2 rounded-lg border p-3" aria-label="Paid now">
        <legend className="px-1 text-sm font-medium">Paid now (optional)</legend>
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="payAmount">Amount (₹)</Label>
            <Input id="payAmount" name="payAmount" inputMode="decimal" maxLength={16} className="w-36" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="payMethod">Method</Label>
            <MethodSelect id="payMethod" required={false} />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="payReference">Reference</Label>
            <Input id="payReference" name="reference" maxLength={100} />
          </div>
        </div>
      </fieldset>
      <div className="flex flex-col gap-1">
        <Label htmlFor="note">Note (optional)</Label>
        <Input id="note" name="note" maxLength={500} />
      </div>
      <Result state={state} />
      <Button type="submit" disabled={pending} className="self-start">
        Save purchase
      </Button>
    </form>
  );
}

export function VoidPurchaseForm(props: { purchaseId: string; idempotencyKey: string; save: FormAction }): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-destructive/40 p-3" aria-label="Void this purchase">
      <h2 className="font-medium">Void this purchase</h2>
      <p className="text-sm text-muted-foreground">
        Takes its stock back out and reverses it in the supplier&apos;s account. Money already paid stays as an advance with the supplier. Refused if
        some of this stock is no longer there. Cannot be undone; enter the correct bill afterwards.
      </p>
      <input type="hidden" name="purchaseId" value={props.purchaseId} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <Label htmlFor="reason">Reason</Label>
      <Input id="reason" name="reason" required minLength={3} maxLength={500} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="confirm" required /> I understand this cannot be undone
      </label>
      <Result state={state} />
      <Button type="submit" variant="destructive" disabled={pending} className="self-start">
        Void purchase
      </Button>
    </form>
  );
}
