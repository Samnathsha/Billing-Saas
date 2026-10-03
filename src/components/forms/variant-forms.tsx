"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormMessage } from "./form-parts";
import type { ProductFormState } from "./product-form";

type Action = (previous: ProductFormState, form: FormData) => Promise<ProductFormState>;

// Selling price / MRP (and cost, when allowed) for one variant, in rupees.
export function PriceForm(props: {
  productId: string;
  variant: { id: string; version: number; label: string; price: string; mrp: string; cost?: string };
  showCost: boolean;
  action: Action;
}): ReactNode {
  const [state, action, pending] = useActionState(props.action, { error: null });
  const v = props.variant;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" aria-label={`Prices of ${v.label}`}>
      <input type="hidden" name="productId" value={props.productId} />
      <input type="hidden" name="variantId" value={v.id} />
      <input type="hidden" name="version" value={v.version} />
      <label className="flex flex-col gap-1 text-xs">
        Price ₹
        <Input name="price" defaultValue={v.price} inputMode="decimal" required className="w-28" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        MRP ₹
        <Input name="mrp" defaultValue={v.mrp} inputMode="decimal" className="w-28" />
      </label>
      {props.showCost ? (
        <label className="flex flex-col gap-1 text-xs">
          Cost ₹
          <Input name="cost" defaultValue={v.cost ?? ""} inputMode="decimal" className="w-28" />
        </label>
      ) : null}
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        Save prices
      </Button>
      <FormMessage kind="error" text={state.error} />
    </form>
  );
}

export function ArchiveButton(props: { kind: "product" | "variant"; id: string; productId: string; active: boolean; action: Action }): ReactNode {
  const [state, action, pending] = useActionState(props.action, { error: null });
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="kind" value={props.kind} />
      <input type="hidden" name="id" value={props.id} />
      <input type="hidden" name="productId" value={props.productId} />
      <input type="hidden" name="archived" value={props.active ? "yes" : "no"} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {props.active ? "Archive" : "Restore"}
      </Button>
      <FormMessage kind="error" text={state.error} />
    </form>
  );
}

// Barcodes of one variant: add one, remove one.
export function BarcodeForms(props: {
  productId: string;
  variantId: string;
  barcodes: { id: string; code: string }[];
  action: Action;
}): ReactNode {
  const [state, action, pending] = useActionState(props.action, { error: null });
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {props.barcodes.map((b) => (
        <form key={b.id} action={action} className="flex items-center gap-1 rounded border px-1">
          <input type="hidden" name="productId" value={props.productId} />
          <input type="hidden" name="barcodeId" value={b.id} />
          <span>{b.code}</span>
          <button type="submit" aria-label={`Remove barcode ${b.code}`} disabled={pending} className="px-1">
            ×
          </button>
        </form>
      ))}
      <form action={action} className="flex items-center gap-1">
        <input type="hidden" name="productId" value={props.productId} />
        <input type="hidden" name="variantId" value={props.variantId} />
        <Input name="code" placeholder="Add barcode" aria-label="New barcode" maxLength={64} required className="h-7 w-40" />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          Add
        </Button>
      </form>
      <FormMessage kind="error" text={state.error} />
    </div>
  );
}
