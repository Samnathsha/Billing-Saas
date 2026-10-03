/**
 * Rebuilds one business's stock from its ledger (every stock movement, in
 * the order applied) and compares it with the stored balances. Read-only:
 * it never changes anything. Exit code 1 if anything differs; a difference
 * is a bug to investigate, never something to "fix" by editing balances.
 *
 *   npm run stock:rebuild -- test <business id>
 *   npm run stock:rebuild -- dev  <business id>
 *
 * Connects as app_user (DATABASE_URL_TEST / DATABASE_URL_DEV), so row-level
 * security limits it to that one business. Prints ids and numbers only.
 */
import { existsSync } from "node:fs";
import pg from "pg";
import { z } from "zod";
import { withStrictSsl } from "./lib/env-file";
import { checkTenantStock } from "./lib/stock-check";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const args = z.tuple([z.enum(["dev", "test"]), z.uuid({ error: "Give the business id (a UUID)." })]).safeParse(process.argv.slice(2));
if (!args.success) {
  console.error("Usage: npm run stock:rebuild -- <dev|test> <business id>");
  process.exit(1);
}
const [target, tenantId] = args.data;
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
    const result = await checkTenantStock(client, tenantId);
    const summary = `${String(result.movements)} movement(s), ${String(result.balances)} balance row(s)`;
    if (result.differences.length === 0) {
      console.log(`stock rebuild OK (${target}): ${summary}; every balance matches its history.`);
      return;
    }
    console.error(`\nstock rebuild FOUND ${String(result.differences.length)} difference(s) (${target}): ${summary}`);
    for (const d of result.differences) {
      console.error(`  - item ${d.variantId} in branch ${d.branchId}: ${d.problem}, history says ${d.expected}, balance says ${d.found}`);
    }
    process.exitCode = 1;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    console.error(`stock rebuild could not run: database error (code ${code}).`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

void main();
