import { randomInt, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { env } from "@/lib/env";
import { auth } from "@/modules/auth/better-auth";
import { emailHash, lockoutKey } from "@/modules/auth/lockout-policy";
import { authServiceUrl } from "../helpers/business";
import { registerVerifiedUser, TEST_PASSWORD } from "../helpers/auth";

// Login limits per account (our plugin) and per IP (Better Auth's limiter),
// and the login security log.

const TOO_MANY = "Too many requests. Please try again later.";
let inspector: pg.Client; // auth_service connection

beforeAll(async () => {
  inspector = new pg.Client({ connectionString: authServiceUrl() });
  await inspector.connect();
});

afterAll(async () => {
  await inspector.end();
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function attempt(email: string, password: string): Promise<string> {
  try {
    await auth.api.signInEmail({ body: { email, password } });
    return "ok";
  } catch (error) {
    const body = (error as { body?: { code?: string; message?: string } }).body;
    return body?.message === TOO_MANY ? "TOO_MANY" : (body?.code ?? String(error));
  }
}

async function setFailures(email: string, count: number, secondsAgo: number): Promise<void> {
  await inspector.query("UPDATE rate_limits SET count = $2, last_request = $3 WHERE key = $1", [
    lockoutKey(email),
    count,
    Date.now() - secondsAgo * 1000,
  ]);
}

describe("per-account limit", () => {
  it("after 5 wrong passwords, even the right password must wait", async () => {
    const user = await registerVerifiedUser("Lock Target");
    for (let i = 0; i < 5; i++) expect(await attempt(user.email, "a wrong long password 1")).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(await attempt(user.email, TEST_PASSWORD)).toBe("TOO_MANY");
  });

  it("an unknown email behaves exactly the same (no hint which emails exist)", async () => {
    const user = await registerVerifiedUser("Known Person");
    const unknown = `nobody-${randomUUID()}@test.invalid`;
    const known: string[] = [];
    const notKnown: string[] = [];
    for (let i = 0; i < 6; i++) {
      known.push(await attempt(user.email, "a wrong long password 2"));
      notKnown.push(await attempt(unknown, "a wrong long password 2"));
    }
    expect(notKnown).toEqual(known);
    expect(known.at(-1)).toBe("TOO_MANY");
  });

  it("the wait grows: 1 minute after 5 failures, 2 minutes after 6", async () => {
    const user = await registerVerifiedUser("Growing Wait");
    for (let i = 0; i < 5; i++) await attempt(user.email, "a wrong long password 3");

    await setFailures(user.email, 5, 61);
    expect(await attempt(user.email, "a wrong long password 3")).toBe("INVALID_EMAIL_OR_PASSWORD"); // now 6

    await setFailures(user.email, 6, 90);
    expect(await attempt(user.email, TEST_PASSWORD)).toBe("TOO_MANY");
    await setFailures(user.email, 6, 121);
    expect(await attempt(user.email, TEST_PASSWORD)).toBe("ok");
  });

  it("a successful login clears the counter", async () => {
    const user = await registerVerifiedUser("Clears Counter");
    for (let i = 0; i < 3; i++) await attempt(user.email, "a wrong long password 4");
    expect(await attempt(user.email, TEST_PASSWORD)).toBe("ok");
    const { rowCount } = await inspector.query("SELECT 1 FROM rate_limits WHERE key = $1", [lockoutKey(user.email)]);
    expect(rowCount).toBe(0);
  });

  it("the counter is forgotten 1 hour after the last failure", async () => {
    const user = await registerVerifiedUser("Forgotten");
    for (let i = 0; i < 5; i++) await attempt(user.email, "a wrong long password 5");
    await setFailures(user.email, 50, 3601);
    expect(await attempt(user.email, "a wrong long password 5")).toBe("INVALID_EMAIL_OR_PASSWORD");
    const { rows } = await inspector.query("SELECT count FROM rate_limits WHERE key = $1", [lockoutKey(user.email)]);
    expect(rows[0]).toEqual({ count: 1 });
  });

  it("parallel wrong attempts are all counted", async () => {
    const email = `burst-${randomUUID()}@test.invalid`;
    await Promise.all(Array.from({ length: 8 }, () => attempt(email, "a wrong long password 6")));
    const { rows } = await inspector.query("SELECT count FROM rate_limits WHERE key = $1", [lockoutKey(email)]);
    expect((rows[0] as { count: number } | undefined)?.count).toBeGreaterThanOrEqual(5);
  });
});

describe("security log", () => {
  it("records failures and locks by email hash, and successes by user, never the plain email", async () => {
    const user = await registerVerifiedUser("Logged Person");
    for (let i = 0; i < 5; i++) await attempt(user.email, "a wrong long password 7");
    await attempt(user.email, TEST_PASSWORD); // locked
    await setFailures(user.email, 5, 61);
    await attempt(user.email, TEST_PASSWORD); // succeeds

    const { rows } = await inspector.query<{ event: string; user_id: string | null; email_hash: string | null }>(
      "SELECT event, user_id, email_hash FROM security_events WHERE email_hash = $1 OR user_id = $2 ORDER BY created_at",
      [emailHash(user.email), user.userId],
    );
    const events = rows.map((r) => r.event);
    expect(events.filter((e) => e === "auth.login_failed")).toHaveLength(5);
    expect(events).toContain("auth.login_locked");
    expect(rows.find((r) => r.event === "auth.login_succeeded" && r.user_id === user.userId)).toBeDefined();

    const leaks = await inspector.query(
      "SELECT 1 FROM security_events WHERE coalesce(email_hash, '') LIKE '%@%' OR coalesce(details::text, '') LIKE $1",
      [`%${user.email}%`],
    );
    expect(leaks.rowCount).toBe(0);
  });
});

describe("per-IP limits (Better Auth's limiter, over HTTP)", () => {
  function post(path: string, ip: string, body: object): Promise<Response> {
    return auth.handler(
      new Request(`${env.authUrl}/api/auth${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: env.authUrl, "X-Forwarded-For": ip },
        body: JSON.stringify(body),
      }),
    );
  }
  const randomIp = (): string => `10.${String(randomInt(256))}.${String(randomInt(256))}.${String(randomInt(1, 255))}`;

  it("sign-in: 10 per minute per IP, then 429 with the same message", async () => {
    const ip = randomIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const response = await post("/sign-in/email", ip, { email: `ip-${randomUUID()}@test.invalid`, password: "a wrong long password 8" });
      statuses.push(response.status);
      if (response.status === 429) expect((await response.json()) as unknown).toEqual({ message: TOO_MANY });
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("another IP is not affected", async () => {
    const response = await post("/sign-in/email", randomIp(), { email: `ip-${randomUUID()}@test.invalid`, password: "x long password 9" });
    expect(response.status).toBe(401);
  });

  it("password-reset requests: 5 per hour per IP", async () => {
    const ip = randomIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await post("/request-password-reset", ip, { email: `r-${randomUUID()}@test.invalid`, redirectTo: "/reset-password" })).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
