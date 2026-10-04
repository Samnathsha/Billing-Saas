"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-messages";
import { Button } from "@/components/ui/button";
import { Field, FormMessage, formText } from "./form-parts";
import { ResendVerificationForm } from "./resend-verification-form";

// Email and password; then, for someone who switched on two-step login
// (Phase 11), the code from their authenticator app or a backup code.
export function LoginForm({ next = null }: { next?: string | null }): ReactNode {
  const router = useRouter();
  const [error, setError] = useState<{ code?: string; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [step, setStep] = useState<"password" | "code" | "backup">("password");

  const done = (): void => {
    // The server reads the new session cookie on the next request and
    // sends the user to the right place.
    router.replace(next ?? "/");
    router.refresh();
  };

  async function submit(form: FormData): Promise<void> {
    setPending(true);
    setError(null);
    const { data, error: failed } = await authClient.signIn.email({
      email: formText(form, "email"),
      password: formText(form, "password"),
    });
    if (failed) {
      setPending(false);
      setError({ code: failed.code, text: authErrorMessage(failed) });
      return;
    }
    if ("twoFactorRedirect" in data && data.twoFactorRedirect === true) {
      setPending(false);
      setStep("code");
      return;
    }
    done();
  }

  async function submitCode(form: FormData): Promise<void> {
    setPending(true);
    setError(null);
    const code = formText(form, "code").replace(/\s+/g, "");
    const { error: failed } = step === "backup" ? await authClient.twoFactor.verifyBackupCode({ code }) : await authClient.twoFactor.verifyTotp({ code });
    if (failed) {
      setPending(false);
      setError({ code: failed.code, text: authErrorMessage(failed) });
      return;
    }
    done();
  }

  if (step !== "password") {
    return (
      <form action={submitCode} className="flex flex-col gap-4" aria-label="Two-step login">
        <p className="text-sm text-muted-foreground">
          {step === "code" ? "Open your authenticator app and enter the 6-digit code for Billing." : "Enter one of the backup codes you saved when you switched on two-step login. Each works once."}
        </p>
        {step === "code" ? (
          <Field id="code" label="Code from your app" type="text" autoComplete="one-time-code" maxLength={6} />
        ) : (
          <Field id="code" label="Backup code" type="text" autoComplete="off" maxLength={40} />
        )}
        <FormMessage kind="error" text={error?.text ?? null} />
        <Button type="submit" disabled={pending}>
          {pending ? "Checking..." : "Log in"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setStep(step === "code" ? "backup" : "code");
            setError(null);
          }}
        >
          {step === "code" ? "Use a backup code instead" : "Use the code from my app"}
        </Button>
      </form>
    );
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
