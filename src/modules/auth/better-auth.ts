import "server-only";
import { hash, verify } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { twoFactor } from "better-auth/plugins/two-factor";
import { getAuthDb } from "@/db/auth-client";
import { env } from "@/lib/env";
import { accounts, rateLimits, sessions, twoFactors, users, verifications } from "./schema";
import { accountLockout } from "./account-lockout";
import { sendEmail } from "./mailer";
import { originGuard } from "./origin-guard";
import { uniformSignUp } from "./uniform-sign-up";
import { isUserActive } from "./repo";
import { securityNotices, sendSecurityNotice } from "./security-notices";
import { secureCookiesFor, SESSION_POLICY } from "./session-policy";

// Better Auth (ADR 0002), running on its own restricted database role
// (auth_service, ADR 0003). Every security choice is set explicitly here.

// Argon2id with the OWASP-recommended baseline (19 MiB, 2 passes, 1 lane).
const ARGON2ID = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

const DAY = 60 * 60 * 24;

export const auth = betterAuth({
  secret: env.authSecret,
  baseURL: env.authUrl,
  database: drizzleAdapter(getAuthDb(), {
    provider: "pg",
    schema: { user: users, session: sessions, account: accounts, verification: verifications, rateLimit: rateLimits, twoFactor: twoFactors },
  }),

  user: {
    // Our users table calls Better Auth's "name" display_name.
    fields: { name: "displayName" },
    additionalFields: {
      // 'active' | 'disabled'; changed only by our server code.
      status: { type: "string", required: false, input: false },
    },
  },

  databaseHooks: {
    session: {
      create: {
        // A disabled account cannot start a session (blueprint 5.2).
        before: async (session) => {
          if (!(await isUserActive(session.userId))) return false;
          return undefined;
        },
      },
    },
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    // No login until the email address is confirmed; no session at sign-up.
    requireEmailVerification: true,
    autoSignIn: false,
    // A password reset logs the account out everywhere.
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 60 * 60,
    // ASVS 2.2.3: the person is told by email (security-notices.ts).
    onPasswordReset: async ({ user }) => {
      await sendSecurityNotice(user.email, "password_reset");
    },
    password: {
      hash: (password) => hash(password, ARGON2ID),
      verify: ({ hash: stored, password }) => verify(stored, password),
    },
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Reset your password",
        text: `Someone asked to reset your password. If it was you, open this link within 1 hour:\n\n${url}\n\nIf it was not you, ignore this email.`,
      });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    expiresIn: DAY,
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Confirm your email address",
        text: `Open this link within 24 hours to confirm your email address:\n\n${url}`,
      });
    },
  },

  // Tokens for verification and reset are stored hashed, never readable.
  verification: { storeIdentifier: "hashed" },

  session: {
    // Idle timeout: the session expires 30 minutes after last use; use
    // extends it (at most every 5 minutes). See session-policy.ts.
    expiresIn: SESSION_POLICY.idleTimeoutSeconds,
    updateAge: SESSION_POLICY.refreshEverySeconds,
    // The 12-hour absolute timeout is enforced by the database (migration
    // 0008 caps expires_at) and again by getRequestContext. freshAge only
    // affects the few Better Auth endpoints that use it.
    freshAge: SESSION_POLICY.absoluteTimeoutSeconds,
    // Off: every request checks the database, so revoking a session stops it
    // at once (ADR 0002).
    cookieCache: { enabled: false },
    additionalFields: {
      // Set only by our server code after a membership check (never input).
      activeTenantId: { type: "string", required: false, input: false },
    },
  },

  // These send session tokens to the browser (get/list) or take one from it
  // (revoke), which would let a page script copy a login. Pages read the
  // session on the server (getRequestContext); the app's own listMySessions
  // / endMySession (my-sessions.ts) replace the rest. Over HTTP they answer
  // 404; server code can still use auth.api.getSession.
  disabledPaths: ["/get-session", "/list-sessions", "/revoke-session"],

  // Per-IP limits (Better Auth's limiter, stored in rate_limits), on in every
  // environment. Per-account limits: the account-lockout plugin below.
  rateLimit: {
    enabled: true,
    storage: "database",
    // Everything else under /api/auth: 100 requests per minute per IP.
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60 * 60, max: 10 },
      "/request-password-reset": { window: 60 * 60, max: 5 },
      "/reset-password": { window: 60 * 60, max: 10 },
      "/send-verification-email": { window: 60 * 60, max: 5 },
      "/change-password": { window: 60 * 60, max: 10 },
      // Two-step login: a 6-digit code must not be guessable by trying.
      "/two-factor/verify-totp": { window: 60, max: 5 },
      "/two-factor/verify-backup-code": { window: 60, max: 5 },
      "/two-factor/enable": { window: 60 * 60, max: 10 },
      "/two-factor/disable": { window: 60 * 60, max: 10 },
    },
  },

  advanced: {
    database: { generateId: "uuid" },
    cookiePrefix: "billing",
    // HttpOnly: page scripts cannot read the cookie. SameSite=Lax: other
    // sites cannot send it with their requests. Secure on https://.
    useSecureCookies: secureCookiesFor(env.authUrl),
    defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
  },

  plugins: [
    // Refuses every state-changing request whose Origin is not this app.
    originGuard(env.authUrl),
    // Sign-up answers the same for new and already-registered emails.
    uniformSignUp(),
    // Refuses passwords found in known data breaches on sign-up, change and
    // reset. Only the first 5 characters of the password's SHA-1 hash leave
    // the server (k-anonymity, padded replies). If the service cannot be
    // reached, the action is refused ("try again later"), never let through.
    // Per-account login limit with growing delay, and the login security log.
    accountLockout(),
    // Emails and log entries for password and two-step login changes.
    securityNotices(),
    haveIBeenPwned({
      customPasswordCompromisedMessage:
        "This password has appeared in a data breach. Please choose a different one.",
    }),
    // Optional two-step login with an authenticator app (blueprint 5.2,
    // Phase 11). Switching it on or off needs the password; on, a login
    // needs the 6-digit code (or a one-time backup code) within 10 minutes
    // of the password. Secret and backup codes are stored encrypted.
    // 10 wrong codes in a row lock the account's two-step login for 15
    // minutes (plus the per-IP limits above). No "trust this device".
    twoFactor({
      issuer: "Billing",
      twoFactorCookieMaxAge: 10 * 60,
      accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 15 * 60 },
    }),
    // nextCookies must stay last: it lets server actions set auth cookies.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
