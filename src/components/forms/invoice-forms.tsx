"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EMPTY, Result, type FormAction } from "./stock-forms";

export function PrintButton(): ReactNode {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => {
        window.print();
      }}
    >
      Print
    </Button>
  );
}

export function VoidInvoiceForm(props: { invoiceId: string; idempotencyKey: string; save: FormAction }): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-destructive/40 p-3 print:hidden" aria-label="Void this bill">
      <h2 className="font-medium">Void this bill</h2>
      <p className="text-sm text-muted-foreground">
        Puts the items back in stock, records the money as refunded and takes the amount off the customer&apos;s account. Only today; cannot be undone.
      </p>
      <input type="hidden" name="invoiceId" value={props.invoiceId} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <Label htmlFor="void-reason">Reason</Label>
      <Input id="void-reason" name="reason" required minLength={3} maxLength={500} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="confirm" required /> I understand this cannot be undone
      </label>
      <Result state={state} />
      <Button type="submit" variant="destructive" disabled={pending} className="self-start">
        Void bill
      </Button>
    </form>
  );
}
