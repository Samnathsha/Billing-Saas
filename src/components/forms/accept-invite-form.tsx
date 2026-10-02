"use client";

import { useActionState, useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "./form-parts";

export interface AcceptState {
  error: string | null;
}

// "Join the business". The token travels in a hidden field; it is taken out
// of the address bar once the page has it.
export function AcceptInviteForm(props: {
  token: string;
  accept: (previous: AcceptState, form: FormData) => Promise<AcceptState>;
}): ReactNode {
  const [state, action, pending] = useActionState(props.accept, { error: null });
  useEffect(() => {
    window.history.replaceState(null, "", "/invite");
  }, []);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={props.token} />
      <FormMessage kind="error" text={state.error} />
      <Button type="submit" disabled={pending}>
        {pending ? "Joining..." : "Join the business"}
      </Button>
    </form>
  );
}
