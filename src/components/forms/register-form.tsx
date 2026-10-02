"use client";

import { useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-messages";
import { Button } from "@/components/ui/button";
import { Field, FormMessage, formText } from "./form-parts";

// Create an account. The answer is the same whether or not the email is
// already registered, so this screen always says "check your email".
export function RegisterForm(): ReactNode {
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(form: FormData): Promise<void> {
    setPending(true);
    setError(null);
    const { error: failed } = await authClient.signUp.email({
      name: formText(form, "name"),
      email: formText(form, "email"),
      password: formText(form, "password"),
      callbackURL: "/verify-email",
    });
    setPending(false);
    if (failed) setError(authErrorMessage(failed));
    else setSent(true);
  }

  if (sent) {
    return (
      <FormMessage
        kind="info"
        text="Check your email. If this address can be used, we have sent a link to confirm it (valid for 24 hours). Then log in."
      />
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-4">
      <Field id="name" label="Your name" type="text" autoComplete="name" maxLength={100} />
      <Field id="email" label="Email" type="email" autoComplete="email" maxLength={254} />
      <Field id="password" label="Password (at least 12 characters)" type="password" autoComplete="new-password" minLength={12} maxLength={128} />
      <FormMessage kind="error" text={error} />
      <Button type="submit" disabled={pending}>
        {pending ? "Creating account..." : "Create account"}
      </Button>
    </form>
  );
}
