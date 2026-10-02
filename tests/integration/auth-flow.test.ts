import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auth } from "@/modules/auth/better-auth";
import { sentTestEmails } from "@/modules/auth/mailer";
import { authServiceUrl } from "../helpers/business";

// Drives Better Auth's real code (as the API routes do) against the test
// database: sign up, verify, log in, password reset, log out.

const PASSWORD = "correct horse battery staple 42";
const email = `flow-${randomUUID()}@test.invalid`;
let inspector: pg.Client; // auth_service connection to look at stored rows

beforeAll(async () => {
  inspector = new pg.Client({ connectionString: authServiceUrl() });
  await inspector.connect();
});

afterAll(async () => {
  await inspector.end();
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

function lastLinkTo(address: string): URL {
  const mail = [...sentTestEmails()].reverse().find((m) => m.to === address);
  const link = mail?.text.match(/https?:\/\/\S+/)?.[0];
  if (link === undefined) throw new Error(`no email with a link was sent to ${address}`);
  return new URL(link);
}

function tokenFrom(link: URL): string {
  const token = link.searchParams.get("token") ?? link.pathname.split("/").pop();
  if (token === undefined || token === "") throw new Error("no token in link");
  return token;
}

async function errorCode(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "no error";
  } catch (error) {
    const body = (error as { body?: { code?: string } }).body;
    return body?.code ?? (error instanceof Error ? error.message : String(error));
  }
}

async function signIn(password = PASSWORD): Promise<Headers> {
  const { headers } = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  const cookie = headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return new Headers({ cookie });
}

describe("sign up and email verification", () => {
  it("creates the account without logging in, and sends a verification email", async () => {
    const result: unknown = await auth.api.signUpEmail({ body: { name: "Flow Owner", email, password: PASSWORD } });
    // The fixed answer (uniform-sign-up.ts): no token, no user data.
    expect(result).toEqual({ status: "check-your-email" });
    const { rows } = await inspector.query(
      "SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1",
      [email],
    );
    expect(rows).toHaveLength(0);
    expect(lastLinkTo(email).pathname).toContain("verify-email");
  });

  it("stores the password as an Argon2id hash, never as text", async () => {
    const { rows } = await inspector.query<{ password: string }>(
      "SELECT a.password FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.email = $1",
      [email],
    );
    expect(rows[0]?.password.startsWith("$argon2id$v=19$m=19456,t=2,p=1$")).toBe(true);
    expect(rows[0]?.password).not.toContain(PASSWORD);
  });

  it("refuses to log in before the email is verified", async () => {
    expect(await errorCode(signIn())).toBe("EMAIL_NOT_VERIFIED");
  });

  it("verifies the email with the link's token", async () => {
    await auth.api.verifyEmail({ query: { token: tokenFrom(lastLinkTo(email)) } });
    const { rows } = await inspector.query("SELECT email_verified FROM users WHERE email = $1", [email]);
    expect(rows[0]).toEqual({ email_verified: true });
  });
});

describe("passwords", () => {
  it.each([
    ["too short (11 characters)", "abcdefghijk"],
    ["too long (129 characters)", "a".repeat(129)],
  ])("rejects a password that is %s", async (_label, password) => {
    const code = await errorCode(
      auth.api.signUpEmail({ body: { name: "X", email: `pw-${randomUUID()}@test.invalid`, password } }),
    );
    expect(code).toMatch(/PASSWORD_TOO_(SHORT|LONG)/);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const wrongPassword = await errorCode(auth.api.signInEmail({ body: { email, password: "wrong password 123" } }));
    const unknownEmail = await errorCode(
      auth.api.signInEmail({ body: { email: `nobody-${randomUUID()}@test.invalid`, password: PASSWORD } }),
    );
    expect(wrongPassword).toBe(unknownEmail);
  });
});

describe("login, sessions and logout", () => {
  it("logs in and the session cookie identifies the user", async () => {
    const headers = await signIn();
    const session = await auth.api.getSession({ headers });
    expect(session?.user.email).toBe(email);
  });

  it("logging out ends the session at once", async () => {
    const headers = await signIn();
    await auth.api.signOut({ headers });
    expect(await auth.api.getSession({ headers })).toBeNull();
  });

  it("deleting the session row (revoke) stops the cookie on the very next request", async () => {
    const headers = await signIn();
    const session = await auth.api.getSession({ headers });
    await inspector.query("DELETE FROM sessions WHERE id = $1", [session?.session.id]);
    expect(await auth.api.getSession({ headers })).toBeNull();
  });
});

describe("password reset", () => {
  let oldSession: Headers;

  it("stores the reset token hashed, never as readable text", async () => {
    oldSession = await signIn();
    await auth.api.requestPasswordReset({ body: { email, redirectTo: "/reset-password" } });
    const token = tokenFrom(lastLinkTo(email));
    const { rows } = await inspector.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM verifications WHERE identifier LIKE '%' || $1 || '%' OR value LIKE '%' || $1 || '%'",
      [token],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("resets the password once, and logs the account out everywhere", async () => {
    const token = tokenFrom(lastLinkTo(email));
    const newPassword = "a brand new long passphrase 7";
    await auth.api.resetPassword({ body: { token, newPassword } });

    expect(await auth.api.getSession({ headers: oldSession })).toBeNull();
    expect(await errorCode(signIn())).not.toBe("no error");
    expect(await errorCode(signIn(newPassword))).toBe("no error");
    // The same link cannot be used twice.
    expect(await errorCode(auth.api.resetPassword({ body: { token, newPassword: "yet another passphrase 99" } }))).not.toBe(
      "no error",
    );
  });
});
