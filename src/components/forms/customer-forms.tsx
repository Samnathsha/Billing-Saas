"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EMPTY, Result, selectClass, type FormAction } from "./stock-forms";
import type { StateChoice } from "./supplier-forms";

interface CustomerValues {
  name: string;
  phone: string | null;
  gstin: string | null;
  stateCode: string | null;
  address: string | null;
  creditLimit: string; // rupees, for the form
}

// Credit limit only for "Discount above limit" (Manager and above); others
// keep the current limit (open question 39).
function CustomerFields(props: { states: StateChoice[]; canGiveCredit: boolean; values?: CustomerValues }): ReactNode {
  const v = props.values;
  return (
    <div className="flex flex-wrap gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="name">Customer name</Label>
        <Input id="name" name="name" required maxLength={200} defaultValue={v?.name ?? ""} className="w-60" />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="phone">Phone</Label>
        <Input id="phone" name="phone" maxLength={20} defaultValue={v?.phone ?? ""} className="w-40" />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="gstin">GSTIN (business customers)</Label>
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
      <div className="flex w-full flex-col gap-1">
        <Label htmlFor="address">Address (printed on GST bills to business customers)</Label>
        <Input id="address" name="address" maxLength={500} defaultValue={v?.address ?? ""} />
      </div>
      {props.canGiveCredit ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="creditLimit">Credit limit (₹, 0 = no credit)</Label>
          <Input id="creditLimit" name="creditLimit" inputMode="decimal" maxLength={16} defaultValue={v?.creditLimit ?? "0"} className="w-40" />
        </div>
      ) : (
        <input type="hidden" name="creditLimit" value={v?.creditLimit ?? "0"} />
      )}
    </div>
  );
}

export function AddCustomerForm(props: { states: StateChoice[]; canGiveCredit: boolean; save: FormAction }): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border p-3" aria-label="Add a customer">
      <h2 className="font-medium">Add a customer</h2>
      <CustomerFields states={props.states} canGiveCredit={props.canGiveCredit} />
      <Result state={state} />
      <Button type="submit" disabled={pending} className="self-start">
        Add customer
      </Button>
    </form>
  );
}

export function EditCustomerForm(props: { states: StateChoice[]; canGiveCredit: boolean; customer: CustomerValues & { id: string; version: number }; save: FormAction }): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border p-3" aria-label="Edit customer">
      <h2 className="font-medium">Details</h2>
      <input type="hidden" name="id" value={props.customer.id} />
      <input type="hidden" name="version" value={props.customer.version} />
      <CustomerFields states={props.states} canGiveCredit={props.canGiveCredit} values={props.customer} />
      <Result state={state} />
      <Button type="submit" variant="outline" disabled={pending} className="self-start">
        Save details
      </Button>
    </form>
  );
}

export function ArchiveCustomerForm(props: { id: string; active: boolean; save: FormAction }): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={props.id} />
      <input type="hidden" name="archived" value={props.active ? "yes" : "no"} />
      <Button type="submit" variant={props.active ? "destructive" : "outline"} size="sm" disabled={pending} className="self-start">
        {props.active ? "Archive customer" : "Restore customer"}
      </Button>
      <Result state={state} />
    </form>
  );
}
