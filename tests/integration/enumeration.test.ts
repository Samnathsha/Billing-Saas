import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { env } from "@/lib/env";
import { auth } from "@/modules/auth/better-auth";
import { registerVerifiedUser } from "../helpers/auth";

// Blueprint Phase 3, test 8: "user enumeration is impossible". Every login
// endpoint that takes an email must answer exactly the same, over HTTP,
// whether the address is unknown, belongs to a verified account, or to an
// account that never confirmed its email.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

const randomIp = (): string => `10.77.${String(randomInt(256))}.${String(randomInt(1, 255))}`;

// Status, body and the names of any cookies set. Ids, times and the email
// itself are replaced, since they differ per request anyway.
async function answer(path: string, body: object): Promise<string> {
  const response = await auth.handler(
    new Request(`${env.authUrl}/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.authUrl, "X-Forwarded-For": randomIp() },
      body: JSON.stringify(body),
    }),
  );
  const text = (await response.text())
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>")
    .replace(/[\w.+-]+@test\.invalid/g, "<email>");
  const cookies = response.headers
    .getSetCookie()
    .map((c) => c.split("=")[0])
    .sort();
  return JSON.stringify({ status: response.status, body: text, cookies });
}

let verified: string;
let unverified: string;
const unknown = (): string => `nobody-${randomUUID()}@test.invalid`;

beforeAll(async () => {
  verified = (await registerVerifiedUser("Known Verified")).email;
  unverified = `never-confirmed-${randomUUID()}@test.invalid`;
  await auth.api.signUpEmail({ body: { name: "Never Confirmed", email: unverified, password: "a long test passphrase 2026" } });
});

describe("every email-taking endpoint answers the same for known and unknown addresses", () => {
  it("sign-up", async () => {
    const body = (email: string) => ({ name: "Someone", email, password: "another long passphrase 77" });
    const fresh = await answer("/sign-up/email", body(unknown()));
    expect(await answer("/sign-up/email", body(verified))).toBe(fresh);
    expect(await answer("/sign-up/email", body(unverified))).toBe(fresh);
  });

  it("sign-up reveals nothing about the account (no id, no user data)", async () => {
    const fresh = JSON.parse(await answer("/sign-up/email", { name: "Someone", email: unknown(), password: "another long passphrase 77" })) as {
      status: number;
      body: string;
    };
    expect(fresh.status).toBe(200);
    expect(fresh.body).not.toContain("<id>");
    expect(fresh.body).not.toContain("<email>");
  });

  it("login with a wrong password", async () => {
    const body = (email: string) => ({ email, password: "a wrong long password 99" });
    const fresh = await answer("/sign-in/email", body(unknown()));
    expect(await answer("/sign-in/email", body(verified))).toBe(fresh);
    expect(await answer("/sign-in/email", body(unverified))).toBe(fresh);
  });

  it("password reset request", async () => {
    const body = (email: string) => ({ email, redirectTo: "/reset-password" });
    const fresh = await answer("/request-password-reset", body(unknown()));
    expect(await answer("/request-password-reset", body(verified))).toBe(fresh);
    expect(await answer("/request-password-reset", body(unverified))).toBe(fresh);
  });

  it("resend the verification email", async () => {
    const body = (email: string) => ({ email });
    const fresh = await answer("/send-verification-email", body(unknown()));
    expect(await answer("/send-verification-email", body(verified))).toBe(fresh);
    expect(await answer("/send-verification-email", body(unverified))).toBe(fresh);
  });
});

describe("signing up with an existing email changes nothing", () => {
  it("the existing account keeps its password and stays verified", async () => {
    await answer("/sign-up/email", { name: "Takeover", email: verified, password: "attacker long passphrase 1" });
    await expect(auth.api.signInEmail({ body: { email: verified, password: "attacker long passphrase 1" } })).rejects.toThrow();
    await expect(auth.api.signInEmail({ body: { email: verified, password: "a long test passphrase 2026" } })).resolves.toBeDefined();
  });
});
