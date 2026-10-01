import { z } from "zod";

// Pure validation of environment variables. src/lib/env.ts runs it once at
// startup. Error messages name the variable and the problem, never the value,
// because values hold passwords.

export type AppMode = "development" | "test" | "production";

export interface Env {
  mode: AppMode;
  databaseUrl: string;
}

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid environment settings:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "EnvError";
  }
}

// An empty value (e.g. "DATABASE_URL_DEV=" copied from .env.example) counts
// as missing.
const postgresUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.url({
    protocol: /^postgres(ql)?$/,
    error: (issue) =>
      issue.input === undefined ? "is missing" : "must be a postgres:// or postgresql:// connection string",
  }),
);

// Each mode requires its own database. The other URL is optional, but if both
// are set they must differ, so tests can never run against the development
// database. Unknown keys are ignored: process.env holds many unrelated values.
const schemas = {
  development: z.object({ DATABASE_URL_DEV: postgresUrl, DATABASE_URL_TEST: postgresUrl.optional() }),
  test: z.object({ DATABASE_URL_TEST: postgresUrl, DATABASE_URL_DEV: postgresUrl.optional() }),
  // Until deployment is set up, a local production build (`npm run build &&
  // npm start`) uses the development database. The deployment phase replaces
  // this with a separate production variable.
  production: z.object({ DATABASE_URL_DEV: postgresUrl, DATABASE_URL_TEST: postgresUrl.optional() }),
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

  const { DATABASE_URL_DEV: devUrl, DATABASE_URL_TEST: testUrl } = result.data;
  if (devUrl !== undefined && testUrl !== undefined && devUrl === testUrl) {
    throw new EnvError(["DATABASE_URL_DEV and DATABASE_URL_TEST must point to different databases"]);
  }

  const databaseUrl = mode === "test" ? testUrl : devUrl;
  if (databaseUrl === undefined) {
    // Unreachable: the schema for this mode requires the URL.
    throw new EnvError([`database URL for ${mode} is missing`]);
  }
  return { mode, databaseUrl };
}
