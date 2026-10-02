import { randomUUID } from "node:crypto";
import { auth } from "@/modules/auth/better-auth";
import { sentTestEmails } from "@/modules/auth/mailer";

export const TEST_PASSWORD = "a long test passphrase 2026";

export interface TestLogin {
  email: string;
  userId: string;
  headers: Headers;
}

function lastLinkTo(address: string): URL {
  const mail = [...sentTestEmails()].reverse().find((m) => m.to === address);
  const link = mail?.text.match(/https?:\/\/\S+/)?.[0];
  if (link === undefined) throw new Error(`no email with a link was sent to ${address}`);
  return new URL(link);
}

export async function logIn(email: string, password = TEST_PASSWORD): Promise<Headers> {
  const { headers } = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  return new Headers({ cookie: headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
}

// Sign up, verify the email with the link from the (test) mailbox, log in:
// exactly what a real person does, through Better Auth's own code.
export async function registerVerifiedUser(name: string): Promise<TestLogin> {
  const email = `${name.toLowerCase().replace(/\W+/g, "-")}-${randomUUID()}@test.invalid`;
  await auth.api.signUpEmail({ body: { name, email, password: TEST_PASSWORD } });
  const token = lastLinkTo(email).searchParams.get("token") ?? "";
  await auth.api.verifyEmail({ query: { token } });
  const headers = await logIn(email);
  const session = await auth.api.getSession({ headers });
  if (session === null) throw new Error("login did not produce a session");
  return { email, userId: session.user.id, headers };
}
