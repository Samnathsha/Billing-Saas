"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-messages";
import { Button } from "@/components/ui/button";
import { Field, FormMessage, formText } from "./form-parts";
import { ForgotPasswordForm } from "./forgot-password-form";

// Sets a new password with the token from the emailed link. After any
// failure the link may be used up (e.g. a breached password still spends
// it), so the page offers a new link straight away.
export function ResetPasswordForm({ token }: { token: string }): ReactNode {
  const [state, setState] = useState<"form" | "done" | "failed">("form");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Take the token out of the address bar and browser history once the
  // page has it, so it is not left behind on a shared computer.
  useEffect(() => {
    window.history.replaceState(null, "", "/reset-password");
  }, []);

  async function submit(form: FormData): Promise<void> {
    setPending(true);
    setError(null);
    const { error: failed } = await authClient.resetPassword({ newPassword: formText(form, "newPassword"), token });
    setPending(false);
    if (failed) {
      setError(authErrorMessage(failed));
      setState("failed");
    } else {
      setState("done");
    }
  }

  if (state === "done") {
    return (
      <div className="flex flex-col gap-3">
        <FormMessage kind="info" text="Your password has been changed, and you have been logged out on every device." />
        <Link href="/login" className="underline">Log in</Link>
      </div>
    );
  }

  if (state === "failed") {
    return (
      <div className="flex flex-col gap-4">
        <FormMessage kind="error" text={error} />
        <p className="text-sm text-muted-foreground">This link may now be used up. Get a new one:</p>
        <ForgotPasswordForm buttonText="Send a new link" />
      </div>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-4">
      <Field id="newPassword" label="New password (at least 12 characters)" type="password" autoComplete="new-password" minLength={12} maxLength={128} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving..." : "Set new password"}
      </Button>
    </form>
  );
}
