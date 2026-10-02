"use client";

import { useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-messages";
import { Button } from "@/components/ui/button";
import { Field, FormMessage, formText } from "./form-parts";

// "Send me a reset link". The answer is the same for every address.
export function ForgotPasswordForm({ buttonText = "Send reset link" }: { buttonText?: string }): ReactNode {
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(form: FormData): Promise<void> {
    setPending(true);
    const { error } = await authClient.requestPasswordReset({
      email: formText(form, "resetEmail"),
      redirectTo: "/reset-password",
    });
    setPending(false);
    setMessage(
      error
        ? { kind: "error", text: authErrorMessage(error) }
        : { kind: "info", text: "If this address has an account, we have sent a link to reset the password (valid for 1 hour)." },
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-3">
      <Field id="resetEmail" label="Email" type="email" autoComplete="email" maxLength={254} />
      <FormMessage kind={message?.kind ?? "info"} text={message?.text ?? null} />
      <Button type="submit" disabled={pending}>
        {buttonText}
      </Button>
    </form>
  );
}
