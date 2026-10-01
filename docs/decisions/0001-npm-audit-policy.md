# 0001: npm audit policy in CI

- Status: Accepted
- Date: 2026-10-01
- Decided by: owner
- Next review: 2026-11-01 (then on the 1st of every month)

## Context

`npm audit` reports 4 moderate warnings (GHSA-67mh-4wv8-2f99). All four come
from one place: `drizzle-kit` 0.31.11 depends on `@esbuild-kit/esm-loader`,
which pulls in an old `esbuild` (0.18.20). The flaw is in esbuild's
development web server, which lets any website read its responses.

`drizzle-kit` is a developer-only tool that generates migration files. It is
never shipped with the app and does not start esbuild's web server, so the
real risk is very low.

`npm audit fix --force` "fixes" this by downgrading `drizzle-kit` to 0.18.1,
which is a breaking change. Forcing a newer esbuild into `drizzle-kit` with an
npm override could break the migration tool.

## Decision

1. CI fails the build on any vulnerability in packages the live app uses:
   `npm audit --omit=dev`.
2. CI also runs the full `npm audit` (including developer tools) and prints
   the result, but does not fail the build on it.
3. Never run `npm audit fix --force`.
4. Re-check the `drizzle-kit` warning on the 1st of every month: update
   `drizzle-kit` to its latest version, run `npm audit`, and record the result
   below. When the warning is gone, mark this decision as resolved.
   `.github/workflows/monthly-audit.yml` runs the full audit on the 1st of
   each month and turns red while any warning remains, as a reminder.

## Consequences

- A vulnerable runtime package always blocks a merge.
- A new vulnerability in a developer tool does not block a merge. Someone must
  read the CI audit output; the monthly check is the safety net.

## Review log

| Date | drizzle-kit version | Warning still present? | Action |
|---|---|---|---|
| 2026-10-01 | 0.31.11 | Yes (4 moderate) | Decision recorded |
