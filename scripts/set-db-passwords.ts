/**
 * Sets new random passwords for app_user, migrator and auth_service in one
 * database, then
 * writes the new connection strings into .env.local. Run it after
 * scripts/db-roles.sql:
 *
 *   npx tsx scripts/set-db-passwords.ts dev
 *   npx tsx scripts/set-db-passwords.ts test
 *
 * It connects with the owner connection string currently in
 * DATABASE_URL_<ENV> (or OWNER_DATABASE_URL_<ENV> if present), and afterwards:
 *   DATABASE_URL_<ENV>          = app_user, pooled connection (the app)
 *   MIGRATOR_DATABASE_URL_<ENV> = migrator, direct connection (migrations)
 *   AUTH_DATABASE_URL_<ENV>     = auth_service, pooled (login library only)
 * The owner connection string is removed from .env.local; get it from the
 * Neon console if you ever need it again.
 *
 * Passwords are never printed, logged, or written into SQL text: they are
 * sent as a query parameter and applied by the server.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import pg from "pg";
import { z } from "zod";
import { connectionUrl, updateEnvLines, valueOf, withStrictSsl, type RoleName } from "./lib/env-file";

const ENV_FILE = ".env.local";

// Constant SQL: the role name and password arrive as transaction-local
// settings set from query parameters, never as text in the statement.
const ALTER_PASSWORD_SQL = `DO $$
BEGIN
  IF current_setting('app.role_name') NOT IN ('app_user', 'migrator', 'auth_service') THEN
    RAISE EXCEPTION 'unexpected role';
  END IF;
  EXECUTE format('ALTER ROLE %I PASSWORD %L', current_setting('app.role_name'), current_setting('app.new_password'));
END
$$`;

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function readEnvFile(): string[] {
  try {
    return readFileSync(ENV_FILE, "utf8").split("\n");
  } catch {
    return fail(`Could not read ${ENV_FILE}. Run this from the project folder.`);
  }
}

async function withClient<T>(connectionString: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: withStrictSsl(connectionString) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function setPassword(client: pg.Client, role: RoleName, password: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.role_name', $1, true), set_config('app.new_password', $2, true)", [
      role,
      password,
    ]);
    await client.query(ALTER_PASSWORD_SQL);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

const roleCheck = z.object({ role: z.string(), superuser: z.boolean(), bypass_rls: z.boolean() });

// Connects with the new credentials and confirms the role is the expected,
// restricted one. Retries briefly in case the new password takes a moment.
async function verify(connectionString: string, expected: RoleName): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const row = await withClient(connectionString, async (client) => {
        const result = await client.query(
          "SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS bypass_rls FROM pg_roles WHERE rolname = current_user",
        );
        return roleCheck.parse(result.rows[0]);
      });
      if (row.role !== expected || row.superuser || row.bypass_rls) {
        fail(`Check failed: ${expected} is not the restricted role it should be. Nothing was written to ${ENV_FILE}.`);
      }
      return;
    } catch (error) {
      if (attempt >= 5) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
        fail(`Could not log in as ${expected} with the new password (error code ${code}). Nothing was written to ${ENV_FILE}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

// Write to a temporary file first, then swap it in, so .env.local is never
// left half-written. Mode 600: readable only by you.
function writeEnvFile(lines: string[], updates: Record<string, string>, remove: string[]): void {
  const temp = `${ENV_FILE}.tmp`;
  writeFileSync(temp, updateEnvLines(lines, updates, remove), { mode: 0o600 });
  renameSync(temp, ENV_FILE);
}

async function main(): Promise<void> {
  const target = z.enum(["dev", "test"]).safeParse(process.argv[2]);
  if (!target.success) fail("Usage: npx tsx scripts/set-db-passwords.ts dev   (or: test)");
  const suffix = target.data.toUpperCase();
  const appKey = `DATABASE_URL_${suffix}`;
  const migratorKey = `MIGRATOR_DATABASE_URL_${suffix}`;
  const authKey = `AUTH_DATABASE_URL_${suffix}`;
  const ownerKey = `OWNER_DATABASE_URL_${suffix}`;

  const lines = readEnvFile();
  const ownerUrl = valueOf(lines, ownerKey) ?? valueOf(lines, appKey);
  if (ownerUrl === undefined) fail(`${appKey} is missing from ${ENV_FILE}.`);

  const passwords: Record<RoleName, string> = {
    app_user: randomBytes(32).toString("base64url"),
    migrator: randomBytes(32).toString("base64url"),
    auth_service: randomBytes(32).toString("base64url"),
  };

  await withClient(ownerUrl, async (client) => {
    const who = await client.query<{ role: string; createrole: boolean }>(
      "SELECT current_user AS role, rolcreaterole AS createrole FROM pg_roles WHERE rolname = current_user",
    );
    const me = who.rows[0];
    if (me === undefined || ["app_user", "migrator", "auth_service"].includes(me.role) || !me.createrole) {
      fail(
        `${appKey} no longer uses the database owner (already switched?).\n` +
          `To set new passwords again, add a line ${ownerKey}=<owner connection string from the Neon console>\n` +
          `to ${ENV_FILE}, run this again, and it will remove that line when done.`,
      );
    }

    const roles = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('app_user', 'migrator', 'auth_service')",
    );
    if (roles.rows[0]?.n !== 3) {
      fail(
        "The app_user, migrator and auth_service roles do not all exist yet. Run the latest scripts/db-roles.sql in the Neon SQL Editor first.",
      );
    }

    await setPassword(client, "app_user", passwords.app_user);
    await setPassword(client, "migrator", passwords.migrator);
    await setPassword(client, "auth_service", passwords.auth_service);
  });

  const appUrl = connectionUrl(ownerUrl, "app_user", passwords.app_user, true);
  const migratorUrl = connectionUrl(ownerUrl, "migrator", passwords.migrator, false);
  await verify(appUrl, "app_user");
  const authUrl = connectionUrl(ownerUrl, "auth_service", passwords.auth_service, true);
  await verify(appUrl, "app_user");
  await verify(migratorUrl, "migrator");
  await verify(authUrl, "auth_service");

  writeEnvFile(lines, { [appKey]: appUrl, [migratorKey]: migratorUrl, [authKey]: authUrl }, [ownerKey]);

  console.log(`\n${target.data}: new passwords set for app_user, migrator and auth_service.`);
  console.log(`  ${appKey} now connects as app_user (pooled).`);
  console.log(`  ${migratorKey} now connects as migrator (direct).`);
  console.log(`  ${authKey} now connects as auth_service (pooled).`);
  console.log(`  Checked: all three log in; none is a superuser or can bypass row-level security.`);
  console.log(`  ${ENV_FILE} updated; the owner connection string is no longer in it.\n`);
}

main().catch((error: unknown) => {
  const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
  fail(`Stopped with a database error (code ${code}). Nothing secret was printed. Paste this message if you need help.`);
});
