import { randomUUID } from "node:crypto";

// Sends one email through Resend's API (POST https://api.resend.com/emails).
// One plain HTTPS call, so no extra package is needed. Pure apart from the
// fetch function passed in, which tests replace.

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

export interface ResendConfig {
  apiKey: string;
  from: string;
}

// Safe to log: says what failed, never the key or the email's content.
export class EmailSendError extends Error {
  constructor(public readonly status: number | "network") {
    super(`Email could not be sent (Resend ${status === "network" ? "unreachable" : `status ${String(status)}`}).`);
    this.name = "EmailSendError";
  }
}

export async function sendViaResend(
  email: OutgoingEmail,
  config: ResendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        // Resend ignores a repeat with the same key for 24 hours, so a retried
        // request cannot send the same email twice.
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({ from: config.from, to: email.to, subject: email.subject, text: email.text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new EmailSendError("network");
  }
  if (!response.ok) throw new EmailSendError(response.status);
}
