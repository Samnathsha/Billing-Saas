import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { env } from "@/lib/env";
import { getRequestContext } from "@/modules/auth";
import { SESSION_POLICY } from "@/modules/auth/session-policy";
import { auth } from "@/modules/auth/better-auth";
import { authServiceUrl } from "../helpers/business";
import { logIn, registerVerifiedUser, TEST_PASSWORD } from "../helpers/auth";

// Session cookies and timeouts (idle 30 min, absolute 12 h), through Better
// Auth's real code and the app's per-request check.

let inspector: pg.Client; // auth_service connection, to age sessions on purpose

beforeAll(async () => {
  inspector = new pg.Client({ connectionString: authServiceUrl() });
  await inspector.connect();
});

afterAll(async () => {
  await inspector.end();
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function sessionRow(headers: Headers): Promise<{ id: string; expires: number } | undefined> {
  const session = await auth.api.getSession({ headers, query: { disableRefresh: true } });
  if (session === null) return undefined;
  const { rows } = await inspector.query<{ expires: Date }>("SELECT expires_at AS expires FROM sessions WHERE id = $1", [
    session.session.id,
  ]);
  const expires = rows[0]?.expires;
  return expires === undefined ? undefined : { id: session.session.id, expires: expires.getTime() };
}

async function age(sessionId: string, column: "created_at" | "expires_at", sql: string): Promise<void> {
  // Fixed statements per column (no SQL built from strings).
  const statement =
    column === "created_at"
      ? "UPDATE sessions SET created_at = now() - $2::interval WHERE id = $1"
      : "UPDATE sessions SET expires_at = now() + $2::interval WHERE id = $1";
  await inspector.query(statement, [sessionId, sql]);
}

describe("session cookie", () => {
  it("is HttpOnly, SameSite=Lax, for the whole site, and lasts the idle timeout", async () => {
    const user = await registerVerifiedUser("Cookie Checker");
    const response = await auth.handler(
      new Request(`${env.authUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: env.authUrl },
        body: JSON.stringify({ email: user.email, password: TEST_PASSWORD }),
      }),
    );
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith("billing.session_token="));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
    expect(cookie).toMatch(/;\s*Path=\//);
    expect(cookie).toMatch(/;\s*Max-Age=1800\b/);
    // Tests run on http://localhost; on https:// the cookie is also Secure
    // (session-policy.test.ts).
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });
});

describe("idle timeout (30 minutes)", () => {
  it("a new session expires 30 minutes after login", async () => {
    const user = await registerVerifiedUser("Idle New");
    const row = await sessionRow(user.headers);
    const minutesLeft = ((row?.expires ?? 0) - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(29);
    expect(minutesLeft).toBeLessThanOrEqual(30);
  });

  it("an idle session (past its expiry) no longer works", async () => {
    const user = await registerVerifiedUser("Idle Gone");
    const row = await sessionRow(user.headers);
    await age(row?.id ?? "", "expires_at", "-1 second");
    expect(await auth.api.getSession({ headers: user.headers })).toBeNull();
    expect(await getRequestContext(user.headers)).toEqual({ kind: "anonymous" });
  });

  it("use extends the session (after 5 minutes since the last extension)", async () => {
    const user = await registerVerifiedUser("Idle Active");
    const row = await sessionRow(user.headers);
    await age(row?.id ?? "", "expires_at", "20 minutes"); // last extended 10 min ago
    await auth.api.getSession({ headers: user.headers });
    const after = await sessionRow(user.headers);
    expect(((after?.expires ?? 0) - Date.now()) / 60_000).toBeGreaterThan(29);
  });

  it("use within 5 minutes does not rewrite the session", async () => {
    const user = await registerVerifiedUser("Idle Recent");
    const row = await sessionRow(user.headers);
    await age(row?.id ?? "", "expires_at", "28 minutes"); // extended 2 min ago
    const before = await sessionRow(user.headers);
    await auth.api.getSession({ headers: user.headers });
    const after = await sessionRow(user.headers);
    expect(after?.expires).toBe(before?.expires);
  });
});

describe("absolute timeout (12 hours from login)", () => {
  it("11 h 59 m after login the session still works", async () => {
    const user = await registerVerifiedUser("Long Day");
    const row = await sessionRow(user.headers);
    await age(row?.id ?? "", "created_at", "11 hours 59 minutes");
    expect((await getRequestContext(user.headers)).kind).toBe("no-business");
  });

  it("12 h 1 m after login the session is ended for good, even if active", async () => {
    const user = await registerVerifiedUser("Too Long");
    const row = await sessionRow(user.headers);
    await age(row?.id ?? "", "created_at", "12 hours 1 minute");
    expect(await getRequestContext(user.headers)).toEqual({ kind: "anonymous" });
    const { rowCount } = await inspector.query("SELECT 1 FROM sessions WHERE id = $1", [row?.id]);
    expect(rowCount).toBe(0);
  });

  it("the database caps every session at 12 hours after login (same value as the policy)", async () => {
    const user = await registerVerifiedUser("Capped");
    const row = await sessionRow(user.headers);
    // Logged in 11 h 50 m ago: even a fresh 30-minute extension must stop at 12 h.
    await age(row?.id ?? "", "created_at", "11 hours 50 minutes");
    await age(row?.id ?? "", "expires_at", "30 minutes");
    const { rows } = await inspector.query<{ max_age_seconds: number }>(
      "SELECT extract(epoch FROM expires_at - created_at)::int AS max_age_seconds FROM sessions WHERE id = $1",
      [row?.id],
    );
    expect(rows[0]?.max_age_seconds).toBe(SESSION_POLICY.absoluteTimeoutSeconds);
  });

  it("after 12 hours even Better Auth's own endpoints refuse the session", async () => {
    const user = await registerVerifiedUser("Expired Everywhere");
    const row = await sessionRow(user.headers);
    await age(row?.id ?? "", "created_at", "12 hours 1 minute");
    expect(await auth.api.getSession({ headers: user.headers })).toBeNull();
    await expect(auth.api.listSessions({ headers: user.headers })).rejects.toThrow();
  });

  it("changing the password needs a session younger than 12 hours", async () => {
    const user = await registerVerifiedUser("Old Session");
    const row = await sessionRow(user.headers);
    await age(row?.id ?? "", "created_at", "12 hours 1 minute");
    const body = { currentPassword: TEST_PASSWORD, newPassword: "a changed long passphrase 5" };
    await expect(auth.api.changePassword({ headers: user.headers, body })).rejects.toThrow();

    const fresh = await logIn(user.email);
    await expect(auth.api.changePassword({ headers: fresh, body })).resolves.toBeDefined();
  });
});
