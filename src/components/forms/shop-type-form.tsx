"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { ProfileFormState } from "./business-profile-form";
import { FormMessage } from "./form-parts";

// Clothing / mobile phone shop: may change only until the first product
// exists (the server enforces it).
export function ShopTypeForm(props: {
  template: "clothing" | "mobile";
  version: number;
  action: (p: ProfileFormState, f: FormData) => Promise<ProfileFormState>;
}): ReactNode {
  const [state, action, pending] = useActionState(props.action, { status: "idle", message: null, fieldErrors: {} });
  return (
    <form action={action} className="flex max-w-xl flex-col gap-2 rounded-lg border p-4" aria-label="Shop type">
      <h2 className="font-semibold">Shop type</h2>
      <input type="hidden" name="version" value={state.version ?? props.version} />
      <div className="flex flex-wrap items-center gap-4">
        {(
          [
            ["clothing", "Clothing shop"],
            ["mobile", "Mobile phone shop"],
          ] as const
        ).map(([value, label]) => (
          <Label key={value} className="font-normal">
            <input type="radio" name="template" value={value} defaultChecked={props.template === value} />
            {label}
          </Label>
        ))}
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          Change shop type
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Can be changed only until the first product is added.</p>
      <FormMessage kind={state.status === "error" ? "error" : "info"} text={state.message} />
    </form>
  );
}
