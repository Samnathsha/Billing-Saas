import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auth } from "@/modules/auth/better-auth";
import { sentTestEmails } from "@/modules/auth/mailer";
import { hibp } from "../helpers/hibp";
import { registerVerifiedUser } from "../helpers/auth";

// The breached-password check (Have I Been Pwned plugin) on sign-up and
// reset, against a stand-in for the HIBP service (tests/helpers/hibp.ts).

const BREACHED = "summer holiday 2019 forever";

beforeEach(() => {
  hibp.reset();
});

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    return (error as { body?: { code?: string } }).body?.code ?? String(error);
  }
}

const newEmail = (): string => `hibp-${randomUUID()}@test.invalid`;

describe("sign-up", () => {
  it("refuses a password found in a data breach", async () => {
    hibp.markBreached(BREACHED);
    expect(await codeOf(auth.api.signUpEmail({ body: { name: "X", email: newEmail(), password: BREACHED } }))).toBe(
      "PASSWORD_COMPROMISED",
    );
  });

  it("accepts a password that is not in any breach", async () => {
    hibp.markBreached(BREACHED);
    expect(
      await codeOf(auth.api.signUpEmail({ body: { name: "X", email: newEmail(), password: "a fresh unique passphrase 77" } })),
    ).toBe("ok");
  });

  it("refuses (does not skip the check) when the breach service is down", async () => {
    hibp.setDown(true);
    const code = await codeOf(
      auth.api.signUpEmail({ body: { name: "X", email: newEmail(), password: "another unique passphrase 88" } }),
    );
    expect(code).not.toBe("ok");
  });

  it("sends only the first 5 characters of the SHA-1 hash, with padding, never the password", async () => {
    const password = "privacy check passphrase 99";
    await auth.api.signUpEmail({ body: { name: "X", email: newEmail(), password } });
    const prefix = createHash("sha1").update(password).digest("hex").toUpperCase().slice(0, 5);
    expect(hibp.requests().map((r) => r.url)).toEqual([`https://api.pwnedpasswords.com/range/${prefix}`]);
    expect(hibp.requests()[0]?.headers.get("Add-Padding")).toBe("true");
    expect(hibp.requests()[0]?.url).not.toContain(password);
  });
});

describe("password reset", () => {
  async function freshResetToken(email: string): Promise<string> {
    await auth.api.requestPasswordReset({ body: { email, redirectTo: "/reset-password" } });
    const mail = [...sentTestEmails()].reverse().find((m) => m.to === email);
    return mail?.text.match(/reset-password\/([^?\s]+)/)?.[1] ?? "";
  }

  it("refuses a breached new password; a new link with a safe password works", async () => {
    const user = await registerVerifiedUser("Reset Checker");
    hibp.markBreached(BREACHED);

    const first = await freshResetToken(user.email);
    expect(await codeOf(auth.api.resetPassword({ body: { token: first, newPassword: BREACHED } }))).toBe(
      "PASSWORD_COMPROMISED",
    );
    // Better Auth uses up the link even when the new password is refused, so
    // the person asks for a new link (the reset screen must say so).
    expect(await codeOf(auth.api.resetPassword({ body: { token: first, newPassword: "a safe brand new phrase 31" } }))).toBe(
      "INVALID_TOKEN",
    );

    const second = await freshResetToken(user.email);
    expect(await codeOf(auth.api.resetPassword({ body: { token: second, newPassword: "a safe brand new phrase 31" } }))).toBe(
      "ok",
    );
  });
});

describe("login is not affected", () => {
  it("logging in does not call the breach service", async () => {
    const user = await registerVerifiedUser("Login Only");
    hibp.reset();
    hibp.setDown(true);
    const { headers } = await auth.api.signInEmail({
      body: { email: user.email, password: "a long test passphrase 2026" },
      returnHeaders: true,
    });
    expect(headers.getSetCookie().length).toBeGreaterThan(0);
    expect(hibp.requests()).toEqual([]);
  });
});
