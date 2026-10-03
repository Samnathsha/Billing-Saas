"use client";

import { useActionState, useEffect, useRef, useState, useTransition, type ReactNode, type RefObject, type SubmitEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormMessage } from "./form-parts";

// Shapes shared with the server actions (app/(app)/_shared/action-result).
export interface ActionState {
  error: string | null;
  done: string | null;
}
export type FormAction = (previous: ActionState, form: FormData) => Promise<ActionState>;
export interface BranchChoice {
  id: string;
  name: string;
}

export const EMPTY: ActionState = { error: null, done: null };

// A form that keeps what was typed when the server refuses it (React clears
// a form after every action by default, so a cashier would have to type a
// whole purchase again), and clears it after a success it reports itself.
export function useKeptForm(state: ActionState, dispatch: (form: FormData) => void, ref: RefObject<HTMLFormElement | null>): (event: SubmitEvent<HTMLFormElement>) => void {
  const [, startTransition] = useTransition();
  useEffect(() => {
    if (state.done !== null) ref.current?.reset();
  }, [state, ref]);
  return (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => {
      dispatch(data);
    });
  };
}

export const selectClass = "h-8 rounded-lg border border-input bg-transparent px-2 text-sm";
const textareaClass = "min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm";

export function BranchSelect({ branches, id = "branchId" }: { branches: BranchChoice[]; id?: string }): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>Branch</Label>
      <select id={id} name="branchId" required defaultValue={branches.length === 1 ? branches[0]?.id : ""} className={selectClass}>
        {branches.length === 1 ? null : <option value="">Choose a branch</option>}
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Result({ state }: { state: ActionState }): ReactNode {
  return (
    <>
      <FormMessage kind="error" text={state.error} />
      <FormMessage kind="info" text={state.done} />
    </>
  );
}

// Opening stock: what is on the shelf on the day the business starts using
// the app. One line per item. The idempotency key changes after each save,
// so a double click saves once.
export function OpeningStockForm(props: { branches: BranchChoice[]; idempotencyKey: string; showCost: boolean; save: FormAction }): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  const formRef = useRef<HTMLFormElement>(null);
  const onSubmit = useKeptForm(state, action, formRef);
  const [rows, setRows] = useState([0]);
  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4">
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <input type="hidden" name="rows" value={rows.join(",")} />
      <BranchSelect branches={props.branches} />
      {rows.map((row, index) => (
        <fieldset key={row} className="flex flex-col gap-2 rounded-lg border p-3" aria-label={`Line ${String(index + 1)}`}>
          <legend className="px-1 text-sm font-medium">Line {index + 1}</legend>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`code-${String(row)}`}>SKU or barcode</Label>
              <Input id={`code-${String(row)}`} name={`code-${String(row)}`} required maxLength={64} className="w-48" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`qty-${String(row)}`}>Quantity</Label>
              <Input id={`qty-${String(row)}`} name={`qty-${String(row)}`} required inputMode="decimal" maxLength={16} className="w-28" />
            </div>
            {props.showCost ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor={`cost-${String(row)}`}>Cost per unit (₹)</Label>
                <Input id={`cost-${String(row)}`} name={`cost-${String(row)}`} inputMode="decimal" maxLength={16} placeholder="Product's cost" className="w-36" />
              </div>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`serials-${String(row)}`}>IMEI / serial numbers (IMEI items only, one per line)</Label>
            <textarea id={`serials-${String(row)}`} name={`serials-${String(row)}`} className={textareaClass} />
          </div>
          {rows.length > 1 ? (
            <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => { setRows(rows.filter((r) => r !== row)); }}>
              Remove line
            </Button>
          ) : null}
        </fieldset>
      ))}
      <Button type="button" variant="outline" className="self-start" onClick={() => { setRows([...rows, Math.max(...rows) + 1]); }}>
        Add a line
      </Button>
      <Result state={state} />
      <Button type="submit" disabled={pending} className="self-start">
        Save opening stock
      </Button>
    </form>
  );
}

const REASONS = [
  ["damaged", "Damaged"],
  ["lost", "Lost / stolen"],
  ["expired", "Expired"],
  ["found", "Found"],
  ["count_correction", "Count correction"],
  ["other", "Other"],
] as const;

export function AdjustStockForm(props: { branches: BranchChoice[]; idempotencyKey: string; save: FormAction }): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  const formRef = useRef<HTMLFormElement>(null);
  const onSubmit = useKeptForm(state, action, formRef);
  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4">
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <BranchSelect branches={props.branches} />
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="code">SKU or barcode</Label>
          <Input id="code" name="code" required maxLength={64} className="w-48" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="direction">Stock goes</Label>
          <select id="direction" name="direction" required defaultValue="out" className={selectClass}>
            <option value="out">Out (less stock)</option>
            <option value="in">In (more stock)</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="quantity">Quantity</Label>
          <Input id="quantity" name="quantity" required inputMode="decimal" maxLength={16} className="w-28" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="reasonCode">Reason</Label>
          <select id="reasonCode" name="reasonCode" required defaultValue="" className={selectClass}>
            <option value="">Choose a reason</option>
            {REASONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="serial">IMEI / serial (IMEI items only)</Label>
          <Input id="serial" name="serial" maxLength={40} className="w-56" />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="note">Note (optional)</Label>
          <Input id="note" name="note" maxLength={500} />
        </div>
      </div>
      <Result state={state} />
      <Button type="submit" disabled={pending} className="self-start">
        Save adjustment
      </Button>
    </form>
  );
}
