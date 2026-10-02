import "server-only";
import { hash, verify } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { getAuthDb } from "@/db/auth-client";
import { env } from "@/lib/env";
import { accounts, rateLimits, sessions, users, verifications } from "./schema";
import { accountLockout } from "./account-lockout";
import { sendEmail } from "./mailer";
import { isUserActive } from "./repo";
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
    schema: { user: users, session: sessions, account: accounts, verification: verifications, rateLimit: rateLimits },
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
    // Refuses passwords found in known data breaches on sign-up, change and
    // reset. Only the first 5 characters of the password's SHA-1 hash leave
    // the server (k-anonymity, padded replies). If the service cannot be
    // reached, the action is refused ("try again later"), never let through.
    // Per-account login limit with growing delay, and the login security log.
    accountLockout(),
    haveIBeenPwned({
      customPasswordCompromisedMessage:
        "This password has appeared in a data breach. Please choose a different one.",
    }),
    // nextCookies must stay last: it lets server actions set auth cookies.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
