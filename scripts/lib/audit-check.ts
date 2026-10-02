import { z } from "zod";

// Decides whether `npm audit --omit=dev --json` output is acceptable, given
// the reviewed allow-list (audit-allowlist.json). Pure, so it is unit-tested.
// A finding passes only if an unexpired entry lists that package at that
// exact location, and every advisory it carries is that entry's advisory.

const allowlistSchema = z.object({
  entries: z.array(
    z.strictObject({
      advisory: z.string().regex(/^GHSA(-[a-z0-9]{4}){3}$/),
      reason: z.string().min(10),
      expires: z.iso.date(),
      packages: z.record(z.string(), z.array(z.string()).min(1)),
    }),
  ),
});

const auditSchema = z.object({
  vulnerabilities: z.record(
    z.string(),
    z.object({
      severity: z.string(),
      via: z.array(z.union([z.string(), z.object({ url: z.string().optional() }).loose()])),
      nodes: z.array(z.string()),
    }),
  ),
});

export type Allowlist = z.infer<typeof allowlistSchema>;

export function parseAllowlist(json: unknown): Allowlist {
  return allowlistSchema.parse(json);
}

function advisoryId(url: string | undefined): string | undefined {
  return url?.match(/GHSA(-[a-z0-9]{4}){3}$/)?.[0];
}

export function checkAudit(auditJson: unknown, allowlist: Allowlist, today: string): string[] {
  const audit = auditSchema.parse(auditJson);
  const problems: string[] = [];

  for (const entry of allowlist.entries) {
    if (entry.expires <= today) {
      problems.push(`Allow-list entry ${entry.advisory} expired on ${entry.expires}: re-check it (ADR 0001) and renew or remove it.`);
    }
  }

  for (const [name, finding] of Object.entries(audit.vulnerabilities)) {
    const entry = allowlist.entries.find((e) => e.expires > today && e.packages[name] !== undefined);
    if (entry === undefined) {
      problems.push(`${name} (${finding.severity}): not on the allow-list.`);
      continue;
    }
    const allowedNodes = entry.packages[name] ?? [];
    const strayNodes = finding.nodes.filter((node) => !allowedNodes.includes(node));
    if (strayNodes.length > 0) {
      problems.push(`${name}: also found at ${strayNodes.join(", ")}, which the allow-list does not cover.`);
    }
    for (const via of finding.via) {
      if (typeof via === "string") {
        if (entry.packages[via] === undefined) problems.push(`${name}: affected through ${via}, which the allow-list does not cover.`);
      } else if (advisoryId(via.url) !== entry.advisory) {
        problems.push(`${name}: advisory ${via.url ?? "(unknown)"} is not the allowed ${entry.advisory}.`);
      }
    }
  }
  return problems;
}
