"use client";

import { useActionState, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EMPTY, Result, selectClass, useKeptForm, type FormAction } from "./stock-forms";

export function RecordExpenseForm(props: {
  categories: { id: string; name: string }[];
  branches: { id: string; name: string }[];
  idempotencyKey: string;
  today: string;
  save: FormAction;
}): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  const formRef = useRef<HTMLFormElement>(null);
  const onSubmit = useKeptForm(state, action, formRef);
  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-3 rounded-lg border p-3" aria-label="Record an expense">
      <h2 className="font-medium">Record an expense</h2>
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="exp-category">Category</Label>
          <select id="exp-category" name="categoryId" required defaultValue="" className={selectClass}>
            <option value="">Choose</option>
            {props.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="exp-amount">Amount (₹)</Label>
          <Input id="exp-amount" name="amount" required inputMode="decimal" maxLength={16} className="w-32" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="exp-method">Paid by</Label>
          <select id="exp-method" name="method" required defaultValue="cash" className={selectClass}>
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            <option value="card">Card</option>
            <option value="bank">Bank transfer</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="exp-date">Date</Label>
          <Input id="exp-date" name="paidOn" type="date" required defaultValue={props.today} max={props.today} className="w-40" />
        </div>
        {props.branches.length > 1 ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="exp-branch">Branch</Label>
            <select id="exp-branch" name="branchId" required defaultValue={props.branches[0]?.id} className={selectClass}>
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
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="exp-description">What for</Label>
          <Input id="exp-description" name="description" required maxLength={200} placeholder="e.g. October rent" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="exp-reference">Reference (optional)</Label>
          <Input id="exp-reference" name="reference" maxLength={60} className="w-40" />
        </div>
      </div>
      <Result state={state} />
      <Button type="submit" disabled={pending} className="self-start">
        Save expense
      </Button>
    </form>
  );
}

export function SimpleActionForm(props: { label: string; fields: Record<string, string>; save: FormAction; input?: { name: string; label: string; required?: boolean } ; variant?: "outline" | "destructive" }): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      {Object.entries(props.fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {props.input === undefined ? null : (
        <Input name={props.input.name} aria-label={props.input.label} placeholder={props.input.label} required={props.input.required} maxLength={500} className="h-7 w-48" />
      )}
      <Button type="submit" variant={props.variant ?? "outline"} size="sm" disabled={pending}>
        {props.label}
      </Button>
      <Result state={state} />
    </form>
  );
}
