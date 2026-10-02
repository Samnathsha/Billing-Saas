/**
 * Writes a random BETTER_AUTH_SECRET (and BETTER_AUTH_URL for local
 * development, if missing) into .env.local. Never prints the secret.
 *
 *   npm run auth:secret             first time
 *   npm run auth:secret -- --rotate replace an existing secret (logs everyone out)
 */
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { updateEnvLines, valueOf } from "./lib/env-file";

const ENV_FILE = ".env.local";
const rotate = process.argv.includes("--rotate");

let lines: string[];
try {
  lines = readFileSync(ENV_FILE, "utf8").split("\n");
} catch {
  console.error(`Could not read ${ENV_FILE}. Run this from the project folder.`);
  process.exit(1);
}

const updates: Record<string, string> = {};
if (valueOf(lines, "BETTER_AUTH_SECRET") === undefined || rotate) {
  updates.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
} else {
  console.log("BETTER_AUTH_SECRET already set; left unchanged (use --rotate to replace it, which logs everyone out).");
}
if (valueOf(lines, "BETTER_AUTH_URL") === undefined) updates.BETTER_AUTH_URL = "http://localhost:3000";

if (Object.keys(updates).length > 0) {
  const temp = `${ENV_FILE}.tmp`;
  writeFileSync(temp, updateEnvLines(lines, updates, []), { mode: 0o600 });
  renameSync(temp, ENV_FILE);
  console.log(`${ENV_FILE} updated: ${Object.keys(updates).join(", ")} (values not shown).`);
}
