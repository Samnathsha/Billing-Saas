/**
 * Prints the backup copies to delete, one per line. Reads the bucket's keys
 * (whitespace separated, as `aws s3api list-objects-v2 --output text`
 * prints them) from stdin. Used by scripts/backup.sh.
 *
 *   ... | npx tsx scripts/backup-prune.ts 2026-10-04
 */
import { readFileSync } from "node:fs";
import { backupsToDelete } from "./lib/backup-prune";

const today = process.argv[2] ?? "";
const keys = readFileSync(0, "utf8").split(/\s+/).filter((k) => k !== "" && k !== "None");
for (const key of backupsToDelete(keys, today)) process.stdout.write(`${key}\n`);
