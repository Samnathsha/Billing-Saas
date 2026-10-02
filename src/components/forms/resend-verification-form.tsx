"use client";

import { useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-messages";
import { Button } from "@/components/ui/button";
import { Field, FormMessage, formText } from "./form-parts";

// "Send the confirmation link again". Same answer for every address.
export function ResendVerificationForm(): ReactNode {
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(form: FormData): Promise<void> {
    setPending(true);
    const { error } = await authClient.sendVerificationEmail({
      email: formText(form, "resendEmail"),
      callbackURL: "/verify-email",
    });
    setPending(false);
    setMessage(
      error
        ? { kind: "error", text: authErrorMessage(error) }
        : { kind: "info", text: "If this address has an account waiting for confirmation, we have sent a new link." },
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-3">
      <Field id="resendEmail" label="Email" type="email" autoComplete="email" maxLength={254} />
      <FormMessage kind={message?.kind ?? "info"} text={message?.text ?? null} />
      <Button type="submit" variant="outline" disabled={pending}>
        Send the link again
      </Button>
    </form>
  );
}
