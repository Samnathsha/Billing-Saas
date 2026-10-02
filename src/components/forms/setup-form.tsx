"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Field, FormMessage } from "./form-parts";

const TEMPLATES = [
  { value: "clothing", label: "Clothing shop" },
  { value: "mobile", label: "Mobile phone shop" },
] as const;

export interface SetupState {
  error: string | null;
}

// The page passes in its server action (components do not import from app/).
export function SetupForm({
  setUpBusiness,
}: {
  setUpBusiness: (previous: SetupState, form: FormData) => Promise<SetupState>;
}): ReactNode {
  const [state, action, pending] = useActionState(setUpBusiness, { error: null });
  return (
    <form action={action} className="flex flex-col gap-4">
      <Field id="businessName" label="Business name" type="text" autoComplete="organization" maxLength={200} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Type of shop</legend>
        {TEMPLATES.map((t, i) => (
          <Label key={t.value} className="font-normal">
            <input type="radio" name="template" value={t.value} defaultChecked={i === 0} required />
            {t.label}
          </Label>
        ))}
      </fieldset>
      <FormMessage kind="error" text={state.error} />
      <Button type="submit" disabled={pending}>
        {pending ? "Setting up..." : "Create my business"}
      </Button>
    </form>
  );
}
