"use client";

import { useActionState, useState, type ReactNode } from "react";
import type { BusinessProfileDto } from "@/modules/tenants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormMessage } from "./form-parts";

export interface ProfileFormState {
  status: "idle" | "saved" | "error";
  message: string | null;
  fieldErrors: Record<string, string>;
  version?: number;
}

const VALIDATE = "Owner or accountant to validate.";

function TextField(props: {
  name: string;
  label: string;
  defaultValue: string | null;
  error: string | undefined;
  autoComplete?: string;
  maxLength: number;
  required?: boolean;
  hint?: string;
}): ReactNode {
  const errorId = `${props.name}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.name}>{props.label}</Label>
      <Input
        id={props.name}
        name={props.name}
        defaultValue={props.defaultValue ?? ""}
        autoComplete={props.autoComplete}
        maxLength={props.maxLength}
        required={props.required}
        aria-invalid={props.error !== undefined}
        aria-describedby={props.error !== undefined ? errorId : undefined}
      />
      {props.hint !== undefined ? <p className="text-xs text-muted-foreground">{props.hint}</p> : null}
      {props.error !== undefined ? (
        <p id={errorId} className="text-sm text-destructive">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

// The page passes in its server action and the list of states (components
// do not import from app/ or use module code).
export function BusinessProfileForm(props: {
  profile: BusinessProfileDto;
  states: readonly { code: string; name: string }[];
  save: (previous: ProfileFormState, form: FormData) => Promise<ProfileFormState>;
}): ReactNode {
  const { profile } = props;
  const [state, action, pending] = useActionState(props.save, { status: "idle", message: null, fieldErrors: {} });
  const errors = state.fieldErrors;
  const [invoicePrefix, setInvoicePrefix] = useState(profile.invoicePrefix);
  const [creditNotePrefix, setCreditNotePrefix] = useState(profile.creditNotePrefix);
  // Example only; the server checks the prefix and makes the real numbers.
  const example = (prefix: string): string => `${prefix.trim().toUpperCase() || "?"}/${profile.financialYear}/00001`;

  return (
    <form action={action} className="flex max-w-xl flex-col gap-6">
      <input type="hidden" name="version" value={state.version ?? profile.version} />

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Business</h2>
        <TextField name="businessName" label="Business name" defaultValue={profile.businessName} error={errors.businessName} autoComplete="organization" maxLength={200} required />
        <TextField name="addressLine1" label="Address" defaultValue={profile.addressLine1} error={errors.addressLine1} autoComplete="address-line1" maxLength={200} />
        <TextField name="addressLine2" label="Address (second line)" defaultValue={profile.addressLine2} error={errors.addressLine2} autoComplete="address-line2" maxLength={200} />
        <TextField name="city" label="City" defaultValue={profile.city} error={errors.city} autoComplete="address-level2" maxLength={100} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="stateCode">State</Label>
          <select
            id="stateCode"
            name="stateCode"
            defaultValue={profile.stateCode ?? ""}
            aria-invalid={errors.stateCode !== undefined}
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
          >
            <option value="">Choose a state</option>
            {props.states.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
          {errors.stateCode !== undefined ? <p className="text-sm text-destructive">{errors.stateCode}</p> : null}
        </div>
        <TextField name="pincode" label="PIN code" defaultValue={profile.pincode} error={errors.pincode} autoComplete="postal-code" maxLength={6} />
        <TextField name="phone" label="Phone" defaultValue={profile.phone} error={errors.phone} autoComplete="tel" maxLength={20} />
        <TextField name="contactEmail" label="Email for customers" defaultValue={profile.contactEmail} error={errors.contactEmail} autoComplete="email" maxLength={254} />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">GST</h2>
        <fieldset className="flex flex-col gap-2" aria-describedby="gst-registration-note">
          <legend className="mb-1 text-sm font-medium">GST registration</legend>
          {(
            [
              ["registered", "Registered (regular)"],
              ["composition", "Composition scheme"],
              ["unregistered", "Not registered"],
            ] as const
          ).map(([value, label]) => (
            <Label key={value} className="font-normal">
              <input type="radio" name="gstRegistration" value={value} defaultChecked={profile.gstRegistration === value} />
              {label}
            </Label>
          ))}
          <p id="gst-registration-note" className="text-xs text-muted-foreground">
            Decides what your bills show. {VALIDATE}
          </p>
          {errors.gstRegistration !== undefined ? <p className="text-sm text-destructive">{errors.gstRegistration}</p> : null}
        </fieldset>
        <TextField
          name="gstin"
          label="GSTIN"
          defaultValue={profile.gstin}
          error={errors.gstin}
          maxLength={20}
          hint="15 characters, e.g. 33ABCDE1234F1Z5. Leave empty if not registered."
        />
        <div className="flex flex-col gap-1">
          <Label className="font-normal">
            <input type="checkbox" name="pricesIncludeTax" defaultChecked={profile.pricesIncludeTax} />
            Selling prices include GST
          </Label>
          <p className="text-xs text-muted-foreground">Usual for shops. {VALIDATE}</p>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Bill numbers</h2>
        <p className="text-sm text-muted-foreground">
          Numbers look like PREFIX/{profile.financialYear}/00001 and start again at 00001 every 1 April. Once the
          year&apos;s first bill is made, a new prefix only applies from the next 1 April. Owner or accountant to validate.
        </p>
        {(
          [
            ["invoicePrefix", "Bill prefix", invoicePrefix, setInvoicePrefix],
            ["creditNotePrefix", "Credit note prefix", creditNotePrefix, setCreditNotePrefix],
          ] as const
        ).map(([name, label, value, setValue]) => (
          <div key={name} className="flex flex-col gap-1.5">
            <Label htmlFor={name}>{label}</Label>
            <Input
              id={name}
              name={name}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
              }}
              maxLength={4}
              required
              className="max-w-32 uppercase"
              aria-invalid={errors[name] !== undefined}
              aria-describedby={`${name}-example`}
            />
            <p id={`${name}-example`} className="text-xs text-muted-foreground">
              First number this year: {example(value)}
            </p>
            {errors[name] !== undefined ? <p className="text-sm text-destructive">{errors[name]}</p> : null}
          </div>
        ))}
      </section>

      <FormMessage kind={state.status === "error" ? "error" : "info"} text={state.message} />
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Saving..." : "Save"}
      </Button>
    </form>
  );
}
