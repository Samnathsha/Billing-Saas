/**
 * Fails (exit code 1) if the database's security setup is weakened: a table
 * without forced row-level security, a tenant table without the isolation
 * policy, a foreign key that skips tenant_id, a view or function that could
 * bypass RLS, or an app_user with too much power. See scripts/lib/check-rls-core.ts.
 *
 *   npm run db:check-rls        (test database, DATABASE_URL_TEST)
 *   npm run db:check-rls:dev    (dev database,  DATABASE_URL_DEV)
 *
 * Reads table definitions only, never business data. Runs in CI.
 */
import { existsSync } from "node:fs";
import pg from "pg";
import { z } from "zod";
import { checkRls } from "./lib/check-rls-core";
import { withStrictSsl } from "./lib/env-file";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const target = z.enum(["dev", "test"]).parse(process.argv[2] ?? "test");
const variable = target === "test" ? "DATABASE_URL_TEST" : "DATABASE_URL_DEV";
const url = process.env[variable];
if (url === undefined || url === "") {
  console.error(`${variable} is not set.`);
  process.exit(1);
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: withStrictSsl(url ?? "") });
  try {
    await client.connect();
    const problems = await checkRls(client);
    if (problems.length > 0) {
      console.error(`\ncheck-rls FAILED (${target} database), ${String(problems.length)} problem(s):`);
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error("");
      process.exitCode = 1;
    } else {
      console.log(`check-rls passed (${target} database): every table has forced row-level security and safe policies.`);
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    console.error(`check-rls could not run: database error (code ${code}).`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

void main();
