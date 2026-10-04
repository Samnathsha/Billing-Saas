"use client";

import { useRouter } from "next/navigation";
import Image from "next/image";
import QRCode from "qrcode";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-messages";
import { Field, FormMessage, formText } from "./form-parts";

// Switching two-step login on (password, then scan the QR code or type the
// key into an authenticator app, then confirm with a code, then save the
// backup codes) or off (password). Recommended for Owner and Admin.

interface Setup {
  qr: string;
  key: string;
  backupCodes: string[];
}

const keyOf = (uri: string): string => (new URL(uri).searchParams.get("secret") ?? "").replace(/(.{4})/g, "$1 ").trim();

export function TwoFactorSettings({ enabled }: { enabled: boolean }): ReactNode {
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function start(form: FormData): Promise<void> {
    setPending(true);
    setError(null);
    const { data, error: failed } = await authClient.twoFactor.enable({ password: formText(form, "password") });
    setPending(false);
    if (failed) {
      setError(authErrorMessage(failed));
      return;
    }
    if (!("totpURI" in data)) {
      setError("Something went wrong. Please try again.");
      return;
    }
    setSetup({ qr: await QRCode.toDataURL(data.totpURI, { margin: 1, width: 200 }), key: keyOf(data.totpURI), backupCodes: data.backupCodes });
  }

  async function confirm(form: FormData): Promise<void> {
    if (setup === null) return;
    setPending(true);
    setError(null);
    const { error: failed } = await authClient.twoFactor.verifyTotp({ code: formText(form, "code").replace(/\s+/g, "") });
    setPending(false);
    if (failed) {
      setError(authErrorMessage(failed));
      return;
    }
    setCodes(setup.backupCodes);
    setSetup(null);
  }

  async function turnOff(form: FormData): Promise<void> {
    setPending(true);
    setError(null);
    const { error: failed } = await authClient.twoFactor.disable({ password: formText(form, "password") });
    setPending(false);
    if (failed) {
      setError(authErrorMessage(failed));
      return;
    }
    router.refresh();
  }

  if (codes !== null) {
    return (
      <section className="flex flex-col gap-3" aria-label="Backup codes">
        <p role="status" className="font-medium">
          Two-step login is on.
        </p>
        <p className="text-sm">Save these backup codes somewhere safe (print them or write them down). Each one logs you in once if you lose your phone. They are not shown again.</p>
        <ul className="grid max-w-sm grid-cols-2 gap-1 rounded-lg border p-3 font-mono text-sm" aria-label="Backup code list">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <Button
          type="button"
          className="self-start"
          onClick={() => {
            setCodes(null);
            router.refresh();
          }}
        >
          I have saved them
        </Button>
      </section>
    );
  }

  if (setup !== null) {
    return (
      <form action={confirm} className="flex max-w-sm flex-col gap-3" aria-label="Confirm two-step login">
        <p className="text-sm">1. In an authenticator app (Google Authenticator, Microsoft Authenticator…), add an account by scanning this code:</p>
        {/* A data: image made in this browser: nothing to optimise or fetch. */}
        <Image src={setup.qr} alt="QR code for your authenticator app" width={200} height={200} unoptimized className="rounded border" />
        <p className="text-sm">
          Or type this key: <span className="font-mono" aria-label="Setup key">{setup.key}</span>
        </p>
        <p className="text-sm">2. Enter the 6-digit code the app shows:</p>
        <Field id="code" label="Code from your app" type="text" autoComplete="one-time-code" maxLength={6} />
        <FormMessage kind="error" text={error} />
        <Button type="submit" disabled={pending}>
          {pending ? "Checking..." : "Turn on two-step login"}
        </Button>
      </form>
    );
  }

  return enabled ? (
    <form action={turnOff} className="flex max-w-sm flex-col gap-3" aria-label="Turn off two-step login">
      <p role="status" className="text-sm font-medium">
        Two-step login is on: logging in needs your password and a code from your app.
      </p>
      <Field id="password" label="Password (to turn it off)" type="password" autoComplete="current-password" maxLength={128} />
      <FormMessage kind="error" text={error} />
      <Button type="submit" variant="outline" disabled={pending}>
        Turn off two-step login
      </Button>
    </form>
  ) : (
    <form action={start} className="flex max-w-sm flex-col gap-3" aria-label="Turn on two-step login">
      <p className="text-sm">Two-step login is off. With it on, a stolen password alone cannot open your account. Recommended for owners and admins.</p>
      <Field id="password" label="Your password" type="password" autoComplete="current-password" maxLength={128} />
      <FormMessage kind="error" text={error} />
      <Button type="submit" disabled={pending}>
        {pending ? "Starting..." : "Set up two-step login"}
      </Button>
    </form>
  );
}
