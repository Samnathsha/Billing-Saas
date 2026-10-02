"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-messages";
import { Button } from "@/components/ui/button";
import { Field, FormMessage, formText } from "./form-parts";
import { ResendVerificationForm } from "./resend-verification-form";

export function LoginForm(): ReactNode {
  const router = useRouter();
  const [error, setError] = useState<{ code?: string; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(form: FormData): Promise<void> {
    setPending(true);
    setError(null);
    const { error: failed } = await authClient.signIn.email({
      email: formText(form, "email"),
      password: formText(form, "password"),
    });
    if (failed) {
      setPending(false);
      setError({ code: failed.code, text: authErrorMessage(failed) });
      return;
    }
    // The server reads the new session cookie on the next request and
    // sends the user to the right place.
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <form action={submit} className="flex flex-col gap-4">
        <Field id="email" label="Email" type="email" autoComplete="email" maxLength={254} />
        <Field id="password" label="Password" type="password" autoComplete="current-password" maxLength={128} />
        <FormMessage kind="error" text={error?.text ?? null} />
        <Button type="submit" disabled={pending}>
          {pending ? "Logging in..." : "Log in"}
        </Button>
      </form>
      {error?.code === "EMAIL_NOT_VERIFIED" ? <ResendVerificationForm /> : null}
    </div>
  );
}
