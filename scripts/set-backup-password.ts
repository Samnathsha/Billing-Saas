/**
 * Sets a new random password for backup_reader (scripts/backup-role.sql)
 * and writes its connection string into .env.local as
 * BACKUP_DATABASE_URL_<ENV>, from where you copy it into the GitHub secret
 * BACKUP_DATABASE_URL (docs/backups.md) and then delete the line.
 *
 *   npx tsx scripts/set-backup-password.ts prod     (or dev, test)
 *
 * Needs OWNER_DATABASE_URL_<ENV> (the owner connection string from the Neon
 * console) in .env.local for this one run; the script removes it again.
 * The password is never printed, logged or written into SQL text.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import pg from "pg";
import { z } from "zod";
import { connectionUrl, updateEnvLines, valueOf, withStrictSsl } from "./lib/env-file";

const ENV_FILE = ".env.local";

const ALTER_PASSWORD_SQL = `DO $$
BEGIN
  EXECUTE format('ALTER ROLE backup_reader PASSWORD %L', current_setting('app.new_password'));
END
$$`;

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
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

async function main(): Promise<void> {
  const target = z.enum(["dev", "test", "prod"]).safeParse(process.argv[2]);
  if (!target.success) fail("Usage: npx tsx scripts/set-backup-password.ts prod   (or: dev, test)");
  const suffix = target.data.toUpperCase();
  const ownerKey = `OWNER_DATABASE_URL_${suffix}`;
  const backupKey = `BACKUP_DATABASE_URL_${suffix}`;
  const lines = readFileSync(ENV_FILE, "utf8").split("\n");
  const ownerUrl = valueOf(lines, ownerKey);
  if (ownerUrl === undefined) fail(`Add a line ${ownerKey}=<owner connection string from the Neon console> to ${ENV_FILE} first.`);

  const password = randomBytes(32).toString("base64url");
  await withClient(ownerUrl, async (client) => {
    const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'backup_reader'");
    if (role.rowCount !== 1) fail("backup_reader does not exist yet. Run scripts/backup-role.sql in the Neon SQL Editor first.");
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.new_password', $1, true)", [password]);
    await client.query(ALTER_PASSWORD_SQL);
    await client.query("COMMIT");
  });

  // pg_dump needs a direct (not pooled) connection.
  const backupUrl = connectionUrl(ownerUrl, "backup_reader", password, false);
  const check = await withClient(backupUrl, async (client) => {
    const r = await client.query<{ role: string; superuser: boolean; bypass: boolean; can_write: boolean }>(
      "SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS bypass, has_table_privilege('invoices', 'INSERT') AS can_write FROM pg_roles WHERE rolname = current_user",
    );
    return r.rows[0];
  });
  if (check?.role !== "backup_reader" || check.superuser || !check.bypass || check.can_write) {
    fail(`backup_reader is not the read-only, all-rows role it should be. Nothing was written to ${ENV_FILE}.`);
  }

  const temp = `${ENV_FILE}.tmp`;
  writeFileSync(temp, updateEnvLines(lines, { [backupKey]: backupUrl }, [ownerKey]), { mode: 0o600 });
  renameSync(temp, ENV_FILE);
  console.log(`\n${target.data}: new password set for backup_reader (checked: reads every row, cannot write).`);
  console.log(`  ${backupKey} is in ${ENV_FILE}. Copy its value into the GitHub secret BACKUP_DATABASE_URL, then delete the line.`);
  console.log(`  The owner connection string was removed from ${ENV_FILE}.\n`);
}

main().catch((error: unknown) => {
  const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
  fail(`Stopped with a database error (code ${code}). Nothing secret was printed.`);
});
