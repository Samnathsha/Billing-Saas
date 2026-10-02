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

const postgresUrl = z.preprocess(
  emptyIsMissing,
  z.url({
    protocol: /^postgres(ql)?$/,
    error: (issue) =>
      issue.input === undefined ? "is missing" : "must be a postgres:// or postgresql:// connection string",
  }),
);

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

const shared = { BETTER_AUTH_SECRET: authSecret, BETTER_AUTH_URL: appUrl };

// Each mode requires its own databases. The other mode's URLs are optional,
// but if both are set they must differ, so tests can never run against the
// development database. Unknown keys are ignored: process.env holds many
// unrelated values.
const devDatabases = {
  DATABASE_URL_DEV: postgresUrl,
  AUTH_DATABASE_URL_DEV: postgresUrl,
  DATABASE_URL_TEST: postgresUrl.optional(),
};
const schemas = {
  development: z.object({ ...devDatabases, ...shared }),
  test: z.object({
    DATABASE_URL_TEST: postgresUrl,
    AUTH_DATABASE_URL_TEST: postgresUrl,
    DATABASE_URL_DEV: postgresUrl.optional(),
    ...shared,
  }),
  // Until deployment is set up, a local production build (`npm run build &&
  // npm start`) uses the development database. The deployment phase replaces
  // this with separate production variables.
  production: z.object({ ...devDatabases, ...shared }),
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

  return {
    mode,
    databaseUrl,
    authDatabaseUrl,
    authSecret: result.data.BETTER_AUTH_SECRET,
    authUrl: result.data.BETTER_AUTH_URL,
  };
}
