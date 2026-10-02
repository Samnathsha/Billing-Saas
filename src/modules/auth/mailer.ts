import "server-only";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@/lib/env";

// Sends the login emails (verification, password reset). A real provider is
// added in Phase 3 part 3.2d. Until then:
// - development: each email is written as a file into .dev-mailbox/
//   (git-ignored), so you can open the link. Never in production.
// - test: emails are kept in memory for the tests to read.
// - production: refuses, so a missing provider can never fail silently.

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

export async function sendEmail(email: Email): Promise<void> {
  if (env.mode === "test") {
    testOutbox.push(email);
    return;
  }
  if (env.mode === "development") {
    const dir = join(process.cwd(), ".dev-mailbox");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
    writeFileSync(file, `To: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n`, { mode: 0o600 });
    console.error(`[dev mailbox] email for ${email.to} saved in .dev-mailbox/ (open the newest file).`);
    return Promise.resolve();
  }
  throw new Error("No email provider is configured (Phase 3 part 3.2d).");
}
