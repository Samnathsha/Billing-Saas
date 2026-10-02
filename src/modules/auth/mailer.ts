import "server-only";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@/lib/env";
import { sendViaResend } from "./resend";

// Sends the login emails (verification, password reset).
// - test: kept in memory for the tests to read; never sent.
// - with RESEND_API_KEY + EMAIL_FROM (required in production): sent through
//   Resend.
// - development without them: written as files into .dev-mailbox/
//   (git-ignored), so you can open the link.

export interface Email {
  to: string;
  subject: string;
  text: string;
}

const testOutbox: Email[] = [];

// Tests only: emails sent so far.
export function sentTestEmails(): readonly Email[] {
  return testOutbox;
}

function saveToDevMailbox(email: Email): void {
  const dir = join(process.cwd(), ".dev-mailbox");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
  writeFileSync(file, `To: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n`, { mode: 0o600 });
  console.error(`[dev mailbox] email for ${email.to} saved in .dev-mailbox/ (open the newest file).`);
}

export async function sendEmail(email: Email): Promise<void> {
  if (env.mode === "test") {
    testOutbox.push(email);
    return;
  }
  if (env.email !== null) {
    try {
      await sendViaResend(email, { apiKey: env.email.resendApiKey, from: env.email.from });
    } catch (error) {
      // The message holds only the status; never the key or the link.
      console.error(error instanceof Error ? error.message : "Email could not be sent.");
      throw error;
    }
    return;
  }
  if (env.mode === "development") {
    saveToDevMailbox(email);
    return;
  }
  // Unreachable: production refuses to start without email settings.
  throw new Error("No email provider is configured.");
}
