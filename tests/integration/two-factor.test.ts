import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { withTenant } from "@/db/with-tenant";
import { createBusiness, getRequestContext } from "@/modules/auth";
import { auth } from "@/modules/auth/better-auth";
import { registerVerifiedUser, TEST_PASSWORD } from "../helpers/auth";

// Two-step login with an authenticator app (blueprint 5.2, Phase 11),
// through Better Auth's real endpoints: switched on only with the password
// and a correct code; then a login needs the code (or a one-time backup
// code); app_user can neither read the secrets nor switch it off.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

const cookiesOf = (headers: Headers): Headers => new Headers({ cookie: headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });

// The secret behind the otpauth:// link, as the authenticator app reads it.
function secretOf(totpURI: string): string {
  const encoded = new URL(totpURI).searchParams.get("secret") ?? "";
  return new TextDecoder().decode(base32.decode(encoded));
}

// Switching on with an authenticator app (not e-mailed codes).
async function startSetup(headers: Headers, password = TEST_PASSWORD): Promise<{ totpURI: string; backupCodes: string[] }> {
  const result = await auth.api.enableTwoFactor({ body: { password }, headers });
  if (result.method !== "totp") throw new Error("expected an authenticator-app setup");
  return result;
}

async function enabledUser(label: string, before?: (user: Awaited<ReturnType<typeof registerVerifiedUser>>) => Promise<void>) {
  const user = await registerVerifiedUser(label);
  if (before !== undefined) await before(user);
  const { totpURI, backupCodes } = await startSetup(user.headers);
  const secret = secretOf(totpURI);
  await auth.api.verifyTOTP({ body: { code: await createOTP(secret).totp() }, headers: user.headers });
  return { ...user, secret, backupCodes };
}

async function passwordStep(email: string) {
  const { headers, response } = await auth.api.signInEmail({ body: { email, password: TEST_PASSWORD }, returnHeaders: true });
  return { pending: cookiesOf(headers), response: response as { twoFactorRedirect?: boolean } };
}

describe("two-step login", () => {
  it("is off until a correct code confirms it; the password alone then no longer logs in", async () => {
    const user = await registerVerifiedUser("2fa setup");
    const { totpURI, backupCodes } = await startSetup(user.headers);
    expect(totpURI).toMatch(/^otpauth:\/\/totp\/Billing:/);
    expect(backupCodes).toHaveLength(10);
    const flag = async () => (await getAuthDb().select({ on: users.twoFactorEnabled }).from(users).where(eq(users.id, user.userId)))[0]?.on;
    // Not on yet: a wrong code does not switch it on.
    await expect(auth.api.verifyTOTP({ body: { code: "000000" }, headers: user.headers })).rejects.toThrow();
    expect(await flag()).toBe(false);
    expect((await passwordStep(user.email)).response.twoFactorRedirect).toBeUndefined();
    await auth.api.verifyTOTP({ body: { code: await createOTP(secretOf(totpURI)).totp() }, headers: user.headers });
    expect(await flag()).toBe(true);

    const { pending, response } = await passwordStep(user.email);
    expect(response.twoFactorRedirect).toBe(true);
    expect(await auth.api.getSession({ headers: pending })).toBeNull();
  });

  it("switching it on needs the password", async () => {
    const user = await registerVerifiedUser("2fa password");
    await expect(startSetup(user.headers, "not the password at all")).rejects.toThrow();
  });

  it("a wrong code is refused; the right code gives a session", async () => {
    const user = await enabledUser("2fa login");
    const { pending } = await passwordStep(user.email);
    await expect(auth.api.verifyTOTP({ body: { code: "123456" }, headers: pending })).rejects.toThrow();
    const { headers } = await auth.api.verifyTOTP({ body: { code: await createOTP(user.secret).totp() }, headers: pending, returnHeaders: true });
    const session = await auth.api.getSession({ headers: cookiesOf(headers) });
    expect(session?.user.id).toBe(user.userId);
  });

  it("a backup code works once", async () => {
    const user = await enabledUser("2fa backup");
    const code = user.backupCodes[0] ?? "";
    const first = await passwordStep(user.email);
    const { headers } = await auth.api.verifyBackupCode({ body: { code }, headers: first.pending, returnHeaders: true });
    expect((await auth.api.getSession({ headers: cookiesOf(headers) }))?.user.id).toBe(user.userId);
    const second = await passwordStep(user.email);
    await expect(auth.api.verifyBackupCode({ body: { code }, headers: second.pending })).rejects.toThrow();
  });

  it("switched off with the password: the password alone logs in again", async () => {
    const user = await enabledUser("2fa off");
    const { pending } = await passwordStep(user.email);
    const { headers } = await auth.api.verifyTOTP({ body: { code: await createOTP(user.secret).totp() }, headers: pending, returnHeaders: true });
    await auth.api.disableTwoFactor({ body: { password: TEST_PASSWORD }, headers: cookiesOf(headers) });
    expect((await passwordStep(user.email)).response.twoFactorRedirect).toBeUndefined();
  });

  it("the app's own database role can neither read the secrets nor switch it off", async () => {
    let ctx: Extract<Awaited<ReturnType<typeof getRequestContext>>, { kind: "member" }>["ctx"] | undefined;
    const user = await enabledUser("2fa guard", async (u) => {
      await createBusiness(u.headers, { businessName: "2FA Shop", template: "clothing" });
      const who = await getRequestContext(u.headers);
      if (who.kind !== "member") throw new Error("member");
      ctx = who.ctx;
    });
    if (ctx === undefined) throw new Error("no business");
    const memberCtx = ctx;
    const refused: unknown = await withTenant(memberCtx, (tx) => tx.execute(sql`SELECT secret FROM two_factors`)).catch((e: unknown) => e);
    const cause = refused instanceof Error && refused.cause instanceof Error ? refused.cause.message : String(refused);
    expect(cause).toMatch(/permission denied/);
    await expect(withTenant(memberCtx, (tx) => tx.update(users).set({ twoFactorEnabled: false }).where(eq(users.id, user.userId)))).rejects.toThrow();
    const [row] = await getAuthDb().select({ on: users.twoFactorEnabled }).from(users).where(eq(users.id, user.userId));
    expect(row?.on).toBe(true);
  });
});
