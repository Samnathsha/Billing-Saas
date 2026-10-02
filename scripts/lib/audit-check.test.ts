import { describe, expect, it } from "vitest";
import { checkAudit, parseAllowlist } from "./audit-check";

const ADVISORY_URL = "https://github.com/advisories/GHSA-67mh-4wv8-2f99";

const allowlist = parseAllowlist({
  entries: [
    {
      advisory: "GHSA-67mh-4wv8-2f99",
      reason: "esbuild dev-server flaw inside drizzle-kit only",
      expires: "2026-11-01",
      packages: {
        esbuild: ["node_modules/@esbuild-kit/core-utils/node_modules/esbuild"],
        "@esbuild-kit/core-utils": ["node_modules/@esbuild-kit/core-utils"],
        "@esbuild-kit/esm-loader": ["node_modules/@esbuild-kit/esm-loader"],
        "drizzle-kit": ["node_modules/drizzle-kit"],
      },
    },
  ],
});

// The real report shape from `npm audit --omit=dev --json` (2026-10-01).
function knownReport(): { vulnerabilities: Record<string, { severity: string; via: unknown[]; nodes: string[] }> } {
  return {
    vulnerabilities: {
      "@esbuild-kit/core-utils": { severity: "moderate", via: ["esbuild"], nodes: ["node_modules/@esbuild-kit/core-utils"] },
      "@esbuild-kit/esm-loader": {
        severity: "moderate",
        via: ["@esbuild-kit/core-utils"],
        nodes: ["node_modules/@esbuild-kit/esm-loader"],
      },
      "drizzle-kit": { severity: "moderate", via: ["@esbuild-kit/esm-loader"], nodes: ["node_modules/drizzle-kit"] },
      esbuild: {
        severity: "moderate",
        via: [{ source: 1102341, name: "esbuild", url: ADVISORY_URL }],
        nodes: ["node_modules/@esbuild-kit/core-utils/node_modules/esbuild"],
      },
    },
  };
}

const TODAY = "2026-10-01";

describe("checkAudit", () => {
  it("passes the known, allow-listed drizzle-kit finding", () => {
    expect(checkAudit(knownReport(), allowlist, TODAY)).toEqual([]);
  });

  it("passes a clean report", () => {
    expect(checkAudit({ vulnerabilities: {} }, allowlist, TODAY)).toEqual([]);
  });

  it("fails on any other vulnerable package", () => {
    const report = knownReport();
    report.vulnerabilities.next = {
      severity: "high",
      via: [{ url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }],
      nodes: ["node_modules/next"],
    };
    expect(checkAudit(report, allowlist, TODAY)).toEqual(["next (high): not on the allow-list."]);
  });

  it("fails if the allowed package shows up at another location", () => {
    const report = knownReport();
    report.vulnerabilities.esbuild?.nodes.push("node_modules/esbuild");
    expect(checkAudit(report, allowlist, TODAY)).toEqual([
      "esbuild: also found at node_modules/esbuild, which the allow-list does not cover.",
    ]);
  });

  it("fails if an allowed package gets a different advisory", () => {
    const report = knownReport();
    report.vulnerabilities.esbuild?.via.push({ url: "https://github.com/advisories/GHSA-zzzz-yyyy-xxxx" });
    expect(checkAudit(report, allowlist, TODAY)).toEqual([
      "esbuild: advisory https://github.com/advisories/GHSA-zzzz-yyyy-xxxx is not the allowed GHSA-67mh-4wv8-2f99.",
    ]);
  });

  it("fails if an allowed package is reached through something not on the list", () => {
    const report = knownReport();
    report.vulnerabilities["drizzle-kit"]?.via.push("some-new-package");
    expect(checkAudit(report, allowlist, TODAY)).toContain(
      "drizzle-kit: affected through some-new-package, which the allow-list does not cover.",
    );
  });

  it("fails everything once the entry has expired", () => {
    const problems = checkAudit(knownReport(), allowlist, "2026-11-01");
    expect(problems[0]).toBe(
      "Allow-list entry GHSA-67mh-4wv8-2f99 expired on 2026-11-01: re-check it (ADR 0001) and renew or remove it.",
    );
    expect(problems).toContain("esbuild (moderate): not on the allow-list.");
  });

  it("rejects a malformed allow-list", () => {
    expect(() => parseAllowlist({ entries: [{ advisory: "anything", reason: "x", expires: "soon", packages: {} }] })).toThrow();
  });
});
