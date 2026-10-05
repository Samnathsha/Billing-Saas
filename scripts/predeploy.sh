#!/usr/bin/env bash
# Pre-deploy check (Phase 12; docs/deploy.md). Every gate must pass before a
# deploy; the first failure stops it with a clear message.
#   npm run predeploy
# Database tests and the RLS check use the TEST database: .env.local, or
# DATABASE_URL_TEST etc. already exported (e.g. the local test database).
set -uo pipefail

step=0
run() {
  step=$((step + 1))
  local name="$1"
  shift
  printf '\n[%d] %s\n' "$step" "$name"
  if "$@" > /tmp/predeploy-step.log 2>&1; then
    printf '    passed\n'
  else
    # Show the end of the output, without anything that looks like a password.
    tail -25 /tmp/predeploy-step.log | sed -E 's#(postgres(ql)?://[^:/@ ]+:)[^@ ]+@#\1[removed]@#g'
    printf '\nNOT READY: "%s" failed. Fix it, then run npm run predeploy again.\n' "$name"
    exit 1
  fi
}

run "Typecheck" npx tsc --noEmit -p .
run "Lint" npm run lint
run "Unit tests" npm test
run "Database tests (test database)" npm run test:db
run "Row-level security check (test database)" npm run db:check-rls
run "Runtime dependency audit" npm run audit:runtime
run "Secret scan of the whole history (gitleaks)" gitleaks git --redact --no-banner .
if command -v semgrep > /dev/null 2>&1; then
  run "Code scan (Semgrep)" semgrep scan --error --metrics=off --config p/javascript --config p/typescript --config p/react --config p/nextjs --config p/owasp-top-ten --config p/secrets --config p/github-actions --config p/dockerfile src scripts tests .github drizzle Dockerfile
else
  printf '\n[-] Semgrep is not installed here: CI runs it on every push.\n'
fi
run "Production build" npm run build

rm -f /tmp/predeploy-step.log
printf '\nReady to deploy: all %d checks passed.\n' "$step"
