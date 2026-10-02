import "server-only";
import { hash, verify } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { getAuthDb } from "@/db/auth-client";
import { env } from "@/lib/env";
import { accounts, rateLimits, sessions, users, verifications } from "./schema";
import { sendEmail } from "./mailer";
import { isUserActive } from "./repo";

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
    // Absolute limit 7 days; refreshed at most once a day while in use.
    // Idle and absolute timeouts are finalised in Phase 3 step 4.
    expiresIn: 7 * DAY,
    updateAge: DAY,
    // Off: every request checks the database, so revoking a session stops it
    // at once (ADR 0002).
    cookieCache: { enabled: false },
    additionalFields: {
      // Set only by our server code after a membership check (never input).
      activeTenantId: { type: "string", required: false, input: false },
    },
  },

  rateLimit: {
    // On in every environment (Better Auth turns it off in development by
    // default). Tuned per route in Phase 3 step 5.
    enabled: true,
    storage: "database",
  },

  advanced: {
    database: { generateId: "uuid" },
    cookiePrefix: "billing",
  },

  // nextCookies must stay last: it lets server actions set auth cookies.
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
