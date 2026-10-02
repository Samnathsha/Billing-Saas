/**
 * DEVELOPMENT ONLY, until staff invitations exist (Phase 4): adds an
 * existing, confirmed account to your business with a role, for testing.
 *
 *   npm run dev:add-member -- <owner email> <staff email> <Admin|Manager|Cashier|Accountant>
 *
 * Uses DATABASE_URL_DEV and AUTH_DATABASE_URL_DEV from .env.local (never
 * test or production). Prints no connection details.
 */
import { existsSync } from "node:fs";
import { addMember, isStaffRole } from "./lib/add-member";
import { withStrictSsl } from "./lib/env-file";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const [ownerEmail, memberEmail, role] = process.argv.slice(2);
const app = process.env.DATABASE_URL_DEV;
const auth = process.env.AUTH_DATABASE_URL_DEV;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("Refused: this is a development tool.");
  if (ownerEmail === undefined || memberEmail === undefined || role === undefined || !isStaffRole(role)) {
    throw new Error("Usage: npm run dev:add-member -- <owner email> <staff email> <Admin|Manager|Cashier|Accountant>");
  }
  if (app === undefined || app === "" || auth === undefined || auth === "") {
    throw new Error("DATABASE_URL_DEV and AUTH_DATABASE_URL_DEV must be set in .env.local.");
  }
  await addMember({ app: withStrictSsl(app), auth: withStrictSsl(auth) }, { ownerEmail, memberEmail, role });
  console.log(`Done: the staff account was added as ${role}. It can log in now.`);
}

main().catch((error: unknown) => {
  // Only our own messages; database errors are reduced to their code.
  const message =
    error instanceof Error && !("code" in error) ? error.message : `database error (code ${String((error as { code?: unknown }).code)})`;
  console.error(`Not added: ${message}`);
  process.exitCode = 1;
});
