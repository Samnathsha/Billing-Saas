/**
 * Daily reconciliation (Phase 12): for every business, bills against their
 * lines, payments, stock movements and customer accounts; returns against
 * stock; stock balances against the full movement history. Read-only.
 *
 *   npx tsx scripts/reconcile.ts <dev|test|prod> [YYYY-MM-DD]
 *
 * Connects as backup_reader (BACKUP_DATABASE_URL_<ENV> in .env.local, or
 * BACKUP_DATABASE_URL in CI). Prints the day's totals per business and
 * every mismatch; exits 1 if there is any.
 */
import pg from "pg";
import { z } from "zod";
import { withStrictSsl } from "./lib/env-file";
import { reconcile } from "./lib/reconcile-core";

const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  const env = z.enum(["dev", "test", "prod"]).safeParse(process.argv[2]);
  const day = process.argv[3] ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() - 86_400_000));
  if (!env.success || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    process.stderr.write("Usage: npx tsx scripts/reconcile.ts <dev|test|prod> [YYYY-MM-DD]\n");
    process.exit(2);
  }
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // CI: settings come from the environment.
  }
  const url = process.env[`BACKUP_DATABASE_URL_${env.data.toUpperCase()}`] ?? process.env.BACKUP_DATABASE_URL;
  if (url === undefined || url === "") {
    process.stderr.write(`BACKUP_DATABASE_URL_${env.data.toUpperCase()} is not set (docs/backups.md).\n`);
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: withStrictSsl(url) });
  await client.connect();
  try {
    const result = await reconcile(client, day);
    process.stdout.write(`Reconciliation for ${day} (${String(result.checks)} checks over all history)\n\n`);
    for (const s of result.summary) {
      process.stdout.write(`  ${s.business}: ${String(s.bills)} bills, sales ${rupees(s.salesPaise)}, received ${rupees(s.receivedPaise)}, returns ${rupees(s.returnsPaise)}\n`);
    }
    if (result.mismatches.length === 0) {
      process.stdout.write("\nNo mismatches.\n");
      return;
    }
    process.stdout.write(`\n${String(result.mismatches.length)} MISMATCH(ES):\n`);
    for (const m of result.mismatches) process.stdout.write(`  [${m.check}] ${m.business}: ${m.detail}\n`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
  process.stderr.write(`Reconciliation stopped with a database error (code ${code}). Nothing was changed.\n`);
  process.exit(2);
});
