import { z } from "zod";

// Pure validation of environment variables. src/lib/env.ts runs it once at
// startup. Error messages name the variable and the problem, never the value,
// because values hold passwords.

export type AppMode = "development" | "test" | "production";
// Where a production build runs (Phase 12): "local" (your computer, with the
// development database), or a real deployment, "staging" or "production",
// with its own databases and secrets.
export type AppEnv = "local" | "staging" | "production";

export interface Env {
  mode: AppMode;
  appEnv: AppEnv;
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
  // Key for /api/maintenance/compact; null: that route is switched off.
  cronSecret: string | null;
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
  // The nightly maintenance call's key (Phase 11; runbook). Optional.
  CRON_SECRET: optional(z.string().min(32, { error: "must be at least 32 characters (run: npm run auth:secret)" })),
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
  // A local production build (`npm run build && npm start`) uses the
  // development database (APP_ENV unset or "local").
  production: z.object({ ...devDatabases, ...shared, RESEND_API_KEY: resendApiKey, EMAIL_FROM: emailFrom }),
} as const;

// A real deployment (APP_ENV=staging or production): its own databases under
// plain names, set in the host's settings; real email; https only.
const deployed = z.object({
  DATABASE_URL: postgresUrl,
  AUTH_DATABASE_URL: postgresUrl,
  ...shared,
  BETTER_AUTH_URL: z.preprocess(emptyIsMissing, z.url({ protocol: /^https$/, error: (issue) => (issue.input === undefined ? "is missing" : "must be the app's https:// address") })),
  RESEND_API_KEY: resendApiKey,
  EMAIL_FROM: emailFrom,
});

// Settings that belong on a developer's computer only. On a deployment they
// mean a mix-up (a live site must never reach the development database).
const LOCAL_ONLY = [
  "DATABASE_URL_DEV",
  "AUTH_DATABASE_URL_DEV",
  "DATABASE_URL_TEST",
  "AUTH_DATABASE_URL_TEST",
  "MIGRATOR_DATABASE_URL_DEV",
  "MIGRATOR_DATABASE_URL_TEST",
  "OWNER_DATABASE_URL_DEV",
  "OWNER_DATABASE_URL_TEST",
];

function readAppEnv(value: string | undefined): AppEnv {
  if (value === undefined || value === "" || value === "local") return "local";
  if (value === "staging" || value === "production") return value;
  throw new EnvError(["APP_ENV must be local, staging or production"]);
}

function parseDeployed(source: Readonly<Record<string, string | undefined>>, appEnv: AppEnv): Env {
  const present = LOCAL_ONLY.filter((key) => (source[key] ?? "") !== "");
  if (present.length > 0) {
    throw new EnvError(present.map((key) => `${key} must not be set on a ${appEnv} server (it belongs to a developer's computer)`));
  }
  const result = deployed.safeParse(source);
  if (!result.success) throw new EnvError(result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`));
  const d = result.data;
  if (d.DATABASE_URL === d.AUTH_DATABASE_URL) throw new EnvError(["DATABASE_URL and AUTH_DATABASE_URL must use different roles"]);
  return {
    mode: "production",
    appEnv,
    databaseUrl: d.DATABASE_URL,
    authDatabaseUrl: d.AUTH_DATABASE_URL,
    authSecret: d.BETTER_AUTH_SECRET,
    authUrl: d.BETTER_AUTH_URL,
    email: { resendApiKey: d.RESEND_API_KEY, from: d.EMAIL_FROM },
    healthDrill: d.HEALTH_DRILL === "fail",
    cronSecret: d.CRON_SECRET ?? null,
  };
}

function readMode(nodeEnv: string | undefined): AppMode {
  if (nodeEnv === undefined || nodeEnv === "" || nodeEnv === "development") return "development";
  if (nodeEnv === "test" || nodeEnv === "production") return nodeEnv;
  throw new EnvError([`NODE_ENV must be development, test or production`]);
}

export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const mode = readMode(source.NODE_ENV);
  const appEnv = readAppEnv(source.APP_ENV);
  if (appEnv !== "local") {
    if (mode !== "production") throw new EnvError([`APP_ENV=${appEnv} needs a production build (NODE_ENV=production)`]);
    return parseDeployed(source, appEnv);
  }
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
    appEnv,
    databaseUrl,
    authDatabaseUrl,
    authSecret: result.data.BETTER_AUTH_SECRET,
    authUrl: result.data.BETTER_AUTH_URL,
    email: apiKey !== undefined && from !== undefined && mode !== "test" ? { resendApiKey: apiKey, from } : null,
    healthDrill: result.data.HEALTH_DRILL === "fail",
    cronSecret: result.data.CRON_SECRET ?? null,
  };
}
