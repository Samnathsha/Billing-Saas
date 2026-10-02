# CI and secret scanning

## GitHub Actions: `.github/workflows/ci.yml`

Runs on every push to `main` and every pull request. Five jobs run in
parallel; all must be green before merging.

| Job | What it does |
|---|---|
| Typecheck, lint, unit tests | `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run db:check` |
| Database tests and check-rls | Starts a throwaway PostgreSQL 18 (pinned image), creates roles with `scripts/db-roles.sql`, runs migrations as `migrator`, then `npm run db:check-rls` and `npm run test:db` |
| Browser tests | Builds the app and runs Playwright (`npm run test:e2e`). On failure the report is uploaded for 7 days. |
| npm audit | `npm run audit:runtime` fails the build on any runtime vulnerability not in the expiring allow-list (`audit-allowlist.json`); full `npm audit` is a warning only ([ADR 0001](decisions/0001-npm-audit-policy.md)) |
| Secret scan | gitleaks scans the **whole git history**, so a secret that was committed and later deleted is still caught |

Hardening: jobs only have read access to the code; every third-party action
is pinned to a commit SHA; the gitleaks download is checked against its
published SHA-256; findings are redacted from logs; `gitleaks:allow` comments
are ignored, so a finding cannot be silenced from inside the code.

Not in CI yet: `npm run test:flows` (full login flows in a real browser).
It needs a database, which the CI browser job does not have; run it locally
with the throwaway database running (docs/database-setup.md) and no other
`next dev` server in this folder. Adding a database to the browser job is
planned with the remaining Phase 3 screens.

## check-rls (`scripts/check-rls.ts`)

Fails if: a table lacks forced RLS; a tenant table lacks the standard
`tenant_isolation` policy or allows a NULL `tenant_id`; a policy targets any
role other than `app_user`; a foreign key between tenant tables skips
`tenant_id`; a view lacks `security_invoker=true`; a `SECURITY DEFINER`
function is not on the reviewed allow-list; or `app_user` owns objects or has
superuser/BYPASSRLS/CREATEROLE/CREATEDB. Run it yourself with
`npm run db:check-rls` (test) or `npm run db:check-rls:dev`.

## Monthly check: `.github/workflows/monthly-audit.yml`

Runs the full `npm audit` at 06:00 UTC on the 1st of each month (and by hand
from the Actions tab). It turns red while the `drizzle-kit` warning remains,
and GitHub emails the owner. Record each result in ADR 0001's review log.

## Pre-commit hook: `.githooks/pre-commit`

Before each commit, gitleaks scans the staged changes and stops the commit
if it finds something that looks like a secret.

- Setup on each computer: `brew install gitleaks`, then `npm install`
  (its `prepare` script runs `git config core.hooksPath .githooks`).
- If gitleaks is not installed, the hook stops the commit and says how to
  install it.
- `git commit --no-verify` skips the hook, but CI scans the same history,
  so the secret is still caught (and by then it is on GitHub: rotate it).

## If a secret is found

1. Do not just delete it in a new commit: the old commit still holds it.
2. Change (rotate) the password or key at its source first.
3. Then ask for help cleaning the history before anything is pushed.
