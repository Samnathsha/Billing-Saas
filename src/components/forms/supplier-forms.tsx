"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EMPTY, Result, selectClass, type FormAction } from "./stock-forms";

export interface StateChoice {
  code: string;
  name: string;
}

function SupplierFields(props: { states: StateChoice[]; values?: { name: string; phone: string | null; gstin: string | null; stateCode: string | null } }): ReactNode {
  const v = props.values;
  return (
    <div className="flex flex-wrap gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="name">Supplier name</Label>
        <Input id="name" name="name" required maxLength={200} defaultValue={v?.name ?? ""} className="w-64" />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="phone">Phone (optional)</Label>
        <Input id="phone" name="phone" maxLength={20} defaultValue={v?.phone ?? ""} className="w-40" />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="gstin">GSTIN (optional)</Label>
        <Input id="gstin" name="gstin" maxLength={20} defaultValue={v?.gstin ?? ""} className="w-48" />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="stateCode">State</Label>
        <select id="stateCode" name="stateCode" defaultValue={v?.stateCode ?? ""} className={selectClass}>
          <option value="">From the GSTIN / not known</option>
          {props.states.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function AddSupplierForm(props: { states: StateChoice[]; save: FormAction }): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border p-3" aria-label="Add a supplier">
      <h2 className="font-medium">Add a supplier</h2>
      <SupplierFields states={props.states} />
      <Result state={state} />
      <Button type="submit" disabled={pending} className="self-start">
        Add supplier
      </Button>
    </form>
  );
}

export function EditSupplierForm(props: {
  states: StateChoice[];
  supplier: { id: string; version: number; name: string; phone: string | null; gstin: string | null; stateCode: string | null };
  save: FormAction;
}): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border p-3" aria-label="Edit supplier">
      <h2 className="font-medium">Details</h2>
      <input type="hidden" name="id" value={props.supplier.id} />
      <input type="hidden" name="version" value={props.supplier.version} />
      <SupplierFields states={props.states} values={props.supplier} />
      <Result state={state} />
      <Button type="submit" variant="outline" disabled={pending} className="self-start">
        Save details
      </Button>
    </form>
  );
}

export function ArchiveSupplierForm(props: { id: string; active: boolean; save: FormAction }): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={props.id} />
      <input type="hidden" name="archived" value={props.active ? "yes" : "no"} />
      <Button type="submit" variant={props.active ? "destructive" : "outline"} size="sm" disabled={pending} className="self-start">
        {props.active ? "Archive supplier" : "Restore supplier"}
      </Button>
      <Result state={state} />
    </form>
  );
}

export function OpeningBalanceForm(props: { supplierId: string; idempotencyKey: string; save: FormAction }): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border p-3" aria-label="Opening balance">
      <h2 className="font-medium">Opening balance</h2>
      <p className="text-sm text-muted-foreground">Dues from before you started using the app. Can be entered once.</p>
      <input type="hidden" name="supplierId" value={props.supplierId} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="opening-amount">Amount (₹)</Label>
          <Input id="opening-amount" name="amount" required inputMode="decimal" maxLength={16} className="w-36" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="opening-side">Which way</Label>
          <select id="opening-side" name="side" required defaultValue="we_owe" className={selectClass}>
            <option value="we_owe">We owe the supplier</option>
            <option value="advance">We paid in advance</option>
          </select>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="opening-note">Note (optional)</Label>
          <Input id="opening-note" name="note" maxLength={500} />
        </div>
      </div>
      <Result state={state} />
      <Button type="submit" variant="outline" disabled={pending} className="self-start">
        Save opening balance
      </Button>
    </form>
  );
}

export const PAYMENT_METHODS = [
  ["cash", "Cash"],
  ["upi", "UPI"],
  ["bank", "Bank transfer"],
  ["cheque", "Cheque"],
] as const;

export function MethodSelect({ id, required = true }: { id: string; required?: boolean }): ReactNode {
  return (
    <select id={id} name="method" required={required} defaultValue="" className={selectClass}>
      <option value="">Choose</option>
      {PAYMENT_METHODS.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

export function SupplierPaymentForm(props: { supplierId: string; idempotencyKey: string; today: string; save: FormAction }): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border p-3" aria-label="Record a payment">
      <h2 className="font-medium">Record a payment to this supplier</h2>
      <input type="hidden" name="supplierId" value={props.supplierId} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="pay-amount">Amount (₹)</Label>
          <Input id="pay-amount" name="amount" required inputMode="decimal" maxLength={16} className="w-36" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pay-method">Method</Label>
          <MethodSelect id="pay-method" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pay-date">Date</Label>
          <Input id="pay-date" name="paidOn" type="date" required defaultValue={props.today} max={props.today} className="w-40" />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="pay-reference">Reference (UTR, cheque no.)</Label>
          <Input id="pay-reference" name="reference" maxLength={100} />
        </div>
      </div>
      <Result state={state} />
      <Button type="submit" disabled={pending} className="self-start">
        Save payment
      </Button>
    </form>
  );
}
