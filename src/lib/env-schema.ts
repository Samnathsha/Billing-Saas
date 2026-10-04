import { z } from "zod";

// Pure validation of environment variables. src/lib/env.ts runs it once at
// startup. Error messages name the variable and the problem, never the value,
// because values hold passwords.

export type AppMode = "development" | "test" | "production";

export interface Env {
  mode: AppMode;
  // app_user: all business code.
  databaseUrl: string;
  // auth_service: the login library only (ADR 0003).
  authDatabaseUrl: string;
  // Better Auth signing/encryption key and the app's own address.
  authSecret: string;
  authUrl: string;
  // Real email sending (Resend). Optional in development (emails then go to
  // .dev-mailbox/), required in production, never used by tests.
  email: { resendApiKey: string; from: string } | null;
  // HEALTH_DRILL=fail: /api/health answers 503, to test that the uptime
  // alert reaches the owner (docs/runbook.md). Never set otherwise.
  healthDrill: boolean;
}

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid environment settings:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "EnvError";
  }
}

// An empty value (e.g. "DATABASE_URL_DEV=" copied from .env.example) counts
// as missing.
const emptyIsMissing = (value: unknown): unknown => (value === "" ? undefined : value);

// For optional settings the empty check must run BEFORE ".optional()", or an
// empty value would be checked as a real one (found by env-schema.test.ts).
const optional = <T extends z.ZodType>(inner: T) => z.preprocess(emptyIsMissing, inner.optional());

const postgresUrlValue = z.url({
  protocol: /^postgres(ql)?$/,
  error: (issue) =>
    issue.input === undefined ? "is missing" : "must be a postgres:// or postgresql:// connection string",
});
const postgresUrl = z.preprocess(emptyIsMissing, postgresUrlValue);

// At least 32 characters: `npm run auth:secret` writes a random 43-character
// one into .env.local.
const authSecret = z.preprocess(
  emptyIsMissing,
  z.string({ error: "is missing" }).min(32, { error: "must be at least 32 characters (run: npm run auth:secret)" }),
);

const appUrl = z.preprocess(
  emptyIsMissing,
  z.url({
    protocol: /^https?$/,
    error: (issue) => (issue.input === undefined ? "is missing" : "must be an http:// or https:// address"),
  }),
);

const resendApiKeyValue = z
  .string({ error: "is missing" })
  .regex(/^re_[A-Za-z0-9_-]{8,}$/, { error: "does not look like a Resend API key (it starts with re_)" });
const resendApiKey = z.preprocess(emptyIsMissing, resendApiKeyValue);

// "noreply@shop.in" or "Shop Name <noreply@shop.in>".
const emailFromValue = z
  .string({ error: "is missing" })
  .regex(/^(?:[^<>@\n]{1,80} <)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/, {
    error: 'must be an email address, e.g. "Shop <noreply@yourdomain.com>"',
  });
const emailFrom = z.preprocess(emptyIsMissing, emailFromValue);

// Error monitoring (Phase 11): Sentry's project address. Optional; not a
// secret (it only allows sending reports), but checked like the rest.
const sentryDsnValue = z.url({ protocol: /^https$/, error: "must be the https:// address Sentry shows (Client Keys / DSN)" });

const shared = {
  BETTER_AUTH_SECRET: authSecret,
  BETTER_AUTH_URL: appUrl,
  RESEND_API_KEY: optional(resendApiKeyValue),
  EMAIL_FROM: optional(emailFromValue),
  SENTRY_DSN: optional(sentryDsnValue),
  NEXT_PUBLIC_SENTRY_DSN: optional(sentryDsnValue),
  HEALTH_DRILL: optional(z.enum(["fail"], { error: 'may only be "fail" (or left out)' })),
};

// Each mode requires its own databases. The other mode's URLs are optional,
// but if both are set they must differ, so tests can never run against the
// development database. Unknown keys are ignored: process.env holds many
// unrelated values.
const devDatabases = {
  DATABASE_URL_DEV: postgresUrl,
  AUTH_DATABASE_URL_DEV: postgresUrl,
  DATABASE_URL_TEST: optional(postgresUrlValue),
};
const schemas = {
  development: z.object({ ...devDatabases, ...shared }),
  test: z.object({
    DATABASE_URL_TEST: postgresUrl,
    AUTH_DATABASE_URL_TEST: postgresUrl,
    DATABASE_URL_DEV: optional(postgresUrlValue),
    ...shared,
  }),
  // Until deployment is set up, a local production build (`npm run build &&
  // npm start`) uses the development database. The deployment phase replaces
  // this with separate production variables.
  production: z.object({ ...devDatabases, ...shared, RESEND_API_KEY: resendApiKey, EMAIL_FROM: emailFrom }),
} as const;

function readMode(nodeEnv: string | undefined): AppMode {
  if (nodeEnv === undefined || nodeEnv === "" || nodeEnv === "development") return "development";
  if (nodeEnv === "test" || nodeEnv === "production") return nodeEnv;
  throw new EnvError([`NODE_ENV must be development, test or production`]);
}

export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const mode = readMode(source.NODE_ENV);
  const result = schemas[mode].safeParse(source);

  if (!result.success) {
    throw new EnvError(result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`));
  }

  const data: Record<string, string | undefined> = result.data;
  const devUrl = data.DATABASE_URL_DEV;
  const testUrl = data.DATABASE_URL_TEST;
  if (devUrl !== undefined && testUrl !== undefined && devUrl === testUrl) {
    throw new EnvError(["DATABASE_URL_DEV and DATABASE_URL_TEST must point to different databases"]);
  }

  const suffix = mode === "test" ? "TEST" : "DEV";
  const databaseUrl = data[`DATABASE_URL_${suffix}`];
  const authDatabaseUrl = data[`AUTH_DATABASE_URL_${suffix}`];
  if (databaseUrl === undefined || authDatabaseUrl === undefined) {
    // Unreachable: the schema for this mode requires both URLs.
    throw new EnvError([`database URLs for ${mode} are missing`]);
  }
  if (databaseUrl === authDatabaseUrl) {
    throw new EnvError([`DATABASE_URL_${suffix} and AUTH_DATABASE_URL_${suffix} must use different roles`]);
  }

  const { RESEND_API_KEY: apiKey, EMAIL_FROM: from } = result.data;
  if ((apiKey === undefined) !== (from === undefined)) {
    throw new EnvError(["RESEND_API_KEY and EMAIL_FROM must be set together"]);
  }

  return {
    mode,
    databaseUrl,
    authDatabaseUrl,
    authSecret: result.data.BETTER_AUTH_SECRET,
    authUrl: result.data.BETTER_AUTH_URL,
    email: apiKey !== undefined && from !== undefined && mode !== "test" ? { resendApiKey: apiKey, from } : null,
    healthDrill: result.data.HEALTH_DRILL === "fail",
  };
}
