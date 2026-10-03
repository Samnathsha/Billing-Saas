"use client";

import { useActionState, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormMessage } from "./form-parts";

export interface ProductFormState {
  error: string | null;
}

export interface ProductFormOptions {
  template: "clothing" | "mobile";
  categories: { id: string; name: string }[];
  brands: { id: string; name: string }[];
  units: { id: string; name: string; code: string }[];
  taxCategories: { code: string; label: string }[];
  canSetCost: boolean;
}

const VARIANT_FIELDS = {
  clothing: [
    ["size", "Size"],
    ["colour", "Colour"],
    ["fabric", "Fabric"],
  ],
  mobile: [
    ["ram", "RAM"],
    ["storage", "Storage"],
    ["colour", "Colour"],
  ],
} as const;

const selectClass = "h-8 rounded-lg border border-input bg-transparent px-2 text-sm";

function Select(props: { id: string; label: string; options: { value: string; label: string }[]; empty?: string; required?: boolean }): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={props.id}>{props.label}</Label>
      <select id={props.id} name={props.id} defaultValue="" required={props.required} className={selectClass}>
        {props.empty !== undefined ? <option value="">{props.empty}</option> : null}
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// "New product" with one or more variant rows. Prices are typed in rupees;
// the server action converts them to paise exactly.
export function NewProductForm(props: {
  options: ProductFormOptions;
  save: (previous: ProductFormState, form: FormData) => Promise<ProductFormState>;
}): ReactNode {
  const { options } = props;
  const [state, action, pending] = useActionState(props.save, { error: null });
  const [rows, setRows] = useState([0]);
  const fields = VARIANT_FIELDS[options.template];
  return (
    <form action={action} className="flex max-w-4xl flex-col gap-6" aria-label="New product">
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label htmlFor="name">Product name</Label>
          <Input id="name" name="name" maxLength={200} required />
        </div>
        <Select id="categoryId" label="Category" empty="— none —" options={options.categories.map((c) => ({ value: c.id, label: c.name }))} />
        <Select id="brandId" label="Brand" empty="— none —" options={options.brands.map((b) => ({ value: b.id, label: b.name }))} />
        <Select id="unitId" label="Unit" required options={options.units.map((u) => ({ value: u.id, label: `${u.name} (${u.code})` }))} />
        <Select id="taxCategory" label="Tax rate" required options={options.taxCategories.map((t) => ({ value: t.code, label: t.label }))} />
        <div className="flex flex-col gap-1">
          <Label htmlFor="hsnCode">HSN code (4, 6 or 8 digits)</Label>
          <Input id="hsnCode" name="hsnCode" maxLength={8} inputMode="numeric" />
        </div>
        {options.template === "mobile" ? (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="model">Model</Label>
              <Input id="model" name="model" maxLength={100} required />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="warrantyMonths">Warranty (months)</Label>
              <Input id="warrantyMonths" name="warrantyMonths" type="number" min={0} max={120} />
            </div>
            <Label className="font-normal">
              <input type="checkbox" name="trackSerial" defaultChecked />
              Track each unit by IMEI / serial number
            </Label>
          </>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Variants</h2>
        <input type="hidden" name="rows" value={rows.join(",")} />
        {rows.map((row, index) => (
          <fieldset key={row} className="flex flex-wrap items-end gap-2 rounded-lg border p-2" aria-label={`Variant ${String(index + 1)}`}>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`sku-${String(row)}`}>SKU</Label>
              <Input id={`sku-${String(row)}`} name={`sku-${String(row)}`} maxLength={40} required className="w-32" />
            </div>
            {fields.map(([key, label]) => (
              <div key={key} className="flex flex-col gap-1">
                <Label htmlFor={`${key}-${String(row)}`}>{label}</Label>
                <Input id={`${key}-${String(row)}`} name={`${key}-${String(row)}`} maxLength={50} className="w-24" />
              </div>
            ))}
            <div className="flex flex-col gap-1">
              <Label htmlFor={`price-${String(row)}`}>Selling price (₹)</Label>
              <Input id={`price-${String(row)}`} name={`price-${String(row)}`} inputMode="decimal" required className="w-28" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`mrp-${String(row)}`}>MRP (₹, optional)</Label>
              <Input id={`mrp-${String(row)}`} name={`mrp-${String(row)}`} inputMode="decimal" className="w-28" />
            </div>
            {options.canSetCost ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor={`cost-${String(row)}`}>Cost (₹, optional)</Label>
                <Input id={`cost-${String(row)}`} name={`cost-${String(row)}`} inputMode="decimal" className="w-28" />
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              <Label htmlFor={`reorder-${String(row)}`}>Reorder at</Label>
              <Input id={`reorder-${String(row)}`} name={`reorder-${String(row)}`} inputMode="decimal" className="w-20" />
            </div>
            {rows.length > 1 ? (
              <Button type="button" variant="outline" size="sm" onClick={() => {
                  setRows(rows.filter((r) => r !== row));
                }}>
                Remove
              </Button>
            ) : null}
          </fieldset>
        ))}
        <Button type="button" variant="outline" className="self-start" onClick={() => {
            setRows([...rows, Math.max(...rows) + 1]);
          }}>
          Add another variant
        </Button>
      </section>

      <FormMessage kind="error" text={state.error} />
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Saving..." : "Save product"}
      </Button>
    </form>
  );
}
