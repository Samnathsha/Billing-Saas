/**
 * Removes a business's data for good, after its owner asked for deletion
 * and the 30-day grace period passed (Phase 11; docs/runbook.md).
 *
 *   npx tsx scripts/purge-business.ts <dev|test|prod> <business id>
 *       shows what would be removed (nothing is changed)
 *   npx tsx scripts/purge-business.ts <dev|test|prod> <business id> --delete "<exact business name>"
 *       removes it
 *
 * Connects as migrator (MIGRATOR_DATABASE_URL_<ENV> in .env.local). Refuses
 * a business that did not ask, or whose date has not come. Photos in local
 * storage are removed too (R2: remove the "<business id>/" folder in the
 * bucket by hand until production storage exists).
 */
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";
import { z } from "zod";
import { withStrictSsl } from "./lib/env-file";
import { purgeBusiness, PurgeRefused } from "./lib/purge-business";

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [target, tenantId = "", flag, name] = process.argv.slice(2);
  const env = z.enum(["dev", "test", "prod"]).safeParse(target);
  if (!env.success || tenantId === "" || (flag !== undefined && (flag !== "--delete" || name === undefined))) {
    fail('Usage: npx tsx scripts/purge-business.ts <dev|test|prod> <business id> [--delete "<exact business name>"]');
  }
  process.loadEnvFile(".env.local");
  const url = process.env[`MIGRATOR_DATABASE_URL_${env.data.toUpperCase()}`];
  if (url === undefined || url === "") fail(`MIGRATOR_DATABASE_URL_${env.data.toUpperCase()} is not in .env.local.`);

  const client = new pg.Client({ connectionString: withStrictSsl(url) });
  await client.connect();
  try {
    const result = await purgeBusiness(client, tenantId, { confirmName: flag === "--delete" ? (name ?? null) : null });
    const total = Object.values(result.rows).reduce((a, b) => a + b, 0);
    console.log(`\nBusiness "${result.businessName}" (deletion date ${result.dueAt}): ${String(total)} rows.`);
    for (const [table, n] of Object.entries(result.rows)) if (n > 0) console.log(`  ${table}: ${String(n)}`);
    if (!result.deleted) {
      console.log('\nNothing was changed. To remove it, run again with --delete "<exact business name>".\n');
      return;
    }
    await rm(join(resolve(process.cwd(), ".local-files"), tenantId), { recursive: true, force: true });
    console.log("\nRemoved. Protections are back on every table (checked). Note the date in docs/runbook.md.\n");
  } catch (error) {
    if (error instanceof PurgeRefused) fail(error.message);
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    fail(`Stopped with a database error (code ${code}); nothing was removed. Nothing secret was printed.`);
  } finally {
    await client.end();
  }
}

void main();
