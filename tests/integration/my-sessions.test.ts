import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { env } from "@/lib/env";
import { endMySession, getRequestContext, listMySessions, logOutEverywhere, NotLoggedInError } from "@/modules/auth";
import { auth } from "@/modules/auth/better-auth";
import { authServiceUrl } from "../helpers/business";
import { logIn, registerVerifiedUser } from "../helpers/auth";

// "Your devices": list my sessions, end one, log out everywhere; and the
// HTTP-level guards around them (blueprint 5.2).

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

const isLoggedIn = async (headers: Headers): Promise<boolean> => (await getRequestContext(headers)).kind !== "anonymous";

async function tokenOf(headers: Headers): Promise<string> {
  const session = await auth.api.getSession({ headers, query: { disableRefresh: true } });
  if (session === null) throw new Error("no session");
  return session.session.token;
}

async function securityEvents(userId: string): Promise<string[]> {
  const { rows } = await inspector.query<{ event: string }>(
    "SELECT event FROM security_events WHERE user_id = $1 ORDER BY created_at",
    [userId],
  );
  return rows.map((r) => r.event);
}

describe("list my sessions", () => {
  it("shows each device once, marks this one, and never contains a token", async () => {
    const user = await registerVerifiedUser("Two Devices");
    const phone = await logIn(user.email);
    const list = await listMySessions(user.headers);
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(["current", "device", "id", "ipAddress", "lastActiveAt", "signedInAt"]);
    const json = JSON.stringify(list);
    expect(json).not.toContain(await tokenOf(user.headers));
    expect(json).not.toContain(await tokenOf(phone));
    // From the phone, the phone is "current".
    const fromPhone = await listMySessions(phone);
    expect(fromPhone.find((s) => s.current)?.id).not.toBe(list.find((s) => s.current)?.id);
  });

  it("shows only my own sessions", async () => {
    const me = await registerVerifiedUser("Only Mine");
    const other = await registerVerifiedUser("Someone Else");
    const otherIds = (await listMySessions(other.headers)).map((s) => s.id);
    const mine = (await listMySessions(me.headers)).map((s) => s.id);
    expect(mine.some((id) => otherIds.includes(id))).toBe(false);
  });

  it("needs a login", async () => {
    await expect(listMySessions(new Headers())).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it("every login is a new session with a new token (no reuse)", async () => {
    const user = await registerVerifiedUser("Fresh Logins");
    const again = await logIn(user.email);
    expect(await tokenOf(again)).not.toBe(await tokenOf(user.headers));
  });
});

describe("end one session", () => {
  it("the other device is logged out at once; this one keeps working", async () => {
    const user = await registerVerifiedUser("Lost Phone");
    const phone = await logIn(user.email);
    const phoneId = (await listMySessions(phone)).find((s) => s.current)?.id ?? "";
    expect(await endMySession(user.headers, { sessionId: phoneId })).toEqual({ ended: true });
    expect(await isLoggedIn(phone)).toBe(false);
    expect(await auth.api.getSession({ headers: phone })).toBeNull();
    expect(await isLoggedIn(user.headers)).toBe(true);
    expect(await securityEvents(user.userId)).toContain("auth.session_ended");
  });

  it("cannot end another user's session (answer is the same as for an unknown id)", async () => {
    const attacker = await registerVerifiedUser("Attacker");
    const victim = await registerVerifiedUser("Victim");
    const victimId = (await listMySessions(victim.headers))[0]?.id ?? "";
    expect(await endMySession(attacker.headers, { sessionId: victimId })).toEqual({ ended: false });
    expect(await endMySession(attacker.headers, { sessionId: randomUUID() })).toEqual({ ended: false });
    expect(await isLoggedIn(victim.headers)).toBe(true);
  });

  it("refuses anything but exactly one session id", async () => {
    const user = await registerVerifiedUser("Strict Input");
    await expect(endMySession(user.headers, { sessionId: "1 OR 1=1" })).rejects.toBeInstanceOf(ZodError);
    await expect(endMySession(user.headers, { sessionId: randomUUID(), userId: user.userId })).rejects.toBeInstanceOf(ZodError);
    await expect(endMySession(user.headers, null)).rejects.toBeInstanceOf(ZodError);
    expect(await isLoggedIn(user.headers)).toBe(true);
  });
});

describe("log out everywhere", () => {
  it("ends every session of mine, this one included, and nobody else's", async () => {
    const user = await registerVerifiedUser("Everywhere");
    const phone = await logIn(user.email);
    const tablet = await logIn(user.email);
    const bystander = await registerVerifiedUser("Bystander");
    expect(await logOutEverywhere(phone)).toEqual({ ended: 3 });
    for (const device of [user.headers, phone, tablet]) expect(await isLoggedIn(device)).toBe(false);
    expect(await isLoggedIn(bystander.headers)).toBe(true);
    expect(await securityEvents(user.userId)).toContain("auth.logged_out_everywhere");
    await expect(logOutEverywhere(phone)).rejects.toBeInstanceOf(NotLoggedInError);
  });
});

describe("over HTTP", () => {
  function post(path: string, headers: Headers, origin: string, body: object = {}): Promise<Response> {
    const h = new Headers(headers);
    h.set("Content-Type", "application/json");
    h.set("Origin", origin);
    return auth.handler(new Request(`${env.authUrl}/api/auth${path}`, { method: "POST", headers: h, body: JSON.stringify(body) }));
  }

  it("Better Auth's token-revealing session endpoints are switched off", async () => {
    const user = await registerVerifiedUser("No Tokens");
    const list = await auth.handler(new Request(`${env.authUrl}/api/auth/list-sessions`, { headers: user.headers }));
    expect(list.status).toBe(404);
    const revoke = await post("/revoke-session", user.headers, env.authUrl, { token: await tokenOf(user.headers) });
    expect(revoke.status).toBe(404);
    expect(await isLoggedIn(user.headers)).toBe(true);
  });

  it("Better Auth refuses a logout sent from another site", async () => {
    const user = await registerVerifiedUser("Cross Site");
    const response = await post("/sign-out", user.headers, "https://evil.example");
    expect(response.status).toBe(403);
    expect(await isLoggedIn(user.headers)).toBe(true);
    expect((await post("/sign-out", user.headers, env.authUrl)).status).toBe(200);
    expect(await isLoggedIn(user.headers)).toBe(false);
  });
});
