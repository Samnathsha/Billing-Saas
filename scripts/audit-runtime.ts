/**
 * Runtime dependency audit for CI (ADR 0001). Runs `npm audit --omit=dev`
 * and fails on every finding except reviewed, unexpired entries in
 * audit-allowlist.json.
 *
 *   npm run audit:runtime
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checkAudit, parseAllowlist } from "./lib/audit-check";

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8" });
let auditJson: unknown;
try {
  auditJson = JSON.parse(result.stdout);
} catch {
  console.error("npm audit did not return a readable report. Output:\n", result.stderr);
  process.exit(1);
}

const allowlist = parseAllowlist(JSON.parse(readFileSync("audit-allowlist.json", "utf8")));
const today = new Date().toISOString().slice(0, 10);
const problems = checkAudit(auditJson, allowlist, today);

if (problems.length > 0) {
  console.error(`\nRuntime audit FAILED (${String(problems.length)} problem(s)):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  process.exit(1);
}
console.log("Runtime audit passed: no vulnerabilities outside the reviewed allow-list.");
