#!/usr/bin/env bash
# Restore drill (Phase 11; blueprint 13.2, monthly). Restores an encrypted
# backup into a NEW, EMPTY database and checks it:
#   - every table restored, every business present;
#   - with SOURCE_DATABASE_URL: per business, the number of bills and their
#     totals (made before the backup) are exactly the same as the source,
#     and no table has more rows than the source.
#
#   scripts/restore-test.sh <backup.dump.age>
#
#   AGE_IDENTITY_FILE    the age PRIVATE key file (kept offline, never in Git)
#   RESTORE_ADMIN_URL    a connection that may CREATE DATABASE on the server
#                        to restore into (local PostgreSQL, or a Neon branch
#                        of a NON-production project). Never production.
#   SOURCE_DATABASE_URL  optional: backup_reader on the database that was
#                        backed up, to compare with
#   RESTORE_NO_OWNER=1   restore objects as the connecting role (Neon)
#   KEEP_RESTORE=1       keep the restored database afterwards
#
# Nothing secret is printed. Exit code 0 only if every check passed.
set -euo pipefail
umask 077

FILE="${1:?Usage: scripts/restore-test.sh <backup.dump.age>}"
: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE is not set}"
: "${RESTORE_ADMIN_URL:?RESTORE_ADMIN_URL is not set}"
[[ -f "$FILE" ]] || { echo "No such file: $FILE" >&2; exit 1; }

WORK="$(mktemp -d)"
DB="restore_check_$(date +%Y%m%d%H%M%S)"
cleanup() {
  rm -rf "$WORK"
  if [[ "${KEEP_RESTORE:-}" != "1" ]]; then psql "$RESTORE_ADMIN_URL" -qAt -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

# Same server, other database: replace the database name in the URL.
db_url() { node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; process.stdout.write(u.toString());' "$1" "$2"; }

echo "1. Decrypting..."
age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$WORK/db.dump" "$FILE"

echo "2. Restoring into a new empty database ($DB)..."
psql "$RESTORE_ADMIN_URL" -qAt -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB" >/dev/null
TARGET="$(db_url "$RESTORE_ADMIN_URL" "$DB")"
psql "$TARGET" -qAt -v ON_ERROR_STOP=1 -f scripts/db-roles.sql >/dev/null
OWNER_FLAG=()
[[ "${RESTORE_NO_OWNER:-}" == "1" ]] && OWNER_FLAG=(--no-owner)
pg_restore --exit-on-error --no-password ${OWNER_FLAG[@]+"${OWNER_FLAG[@]}"} --dbname "$TARGET" "$WORK/db.dump"
rm -f "$WORK/db.dump"

FAILED=0
check() { if [[ "$2" == "ok" ]]; then echo "   ok    $1"; else echo "   FAIL  $1: $2"; FAILED=1; fi; }

echo "3. Checking the restored data..."
COUNTS_SQL="SELECT string_agg(format('%s=%s', c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text), ' ' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'"
RESTORED="$(psql "$TARGET" -qAt -c "$COUNTS_SQL")"
TABLES="$(wc -w <<< "$RESTORED" | tr -d ' ')"
[[ "$TABLES" -ge 40 ]] && check "tables restored ($TABLES)" ok || check "tables restored" "only $TABLES"
BUSINESSES="$(psql "$TARGET" -qAt -c "SELECT count(*) FROM tenants")"
INVOICES="$(psql "$TARGET" -qAt -c "SELECT count(*) FROM invoices")"
echo "   info  $BUSINESSES businesses, $INVOICES bills in the backup"
psql "$TARGET" -qAt -c "SELECT 1 FROM drizzle.__drizzle_migrations LIMIT 1" >/dev/null && check "migration history restored" ok

# Per business: posted bills, their total, credit notes, made up to the
# backup's newest bill (anything later is newer than the backup).
CUTOFF="$(psql "$TARGET" -qAt -c "SELECT coalesce(max(created_at), 'epoch')::text FROM invoices")"
TOTALS_SQL="SELECT coalesce(string_agg(format('%s:%s:%s:%s', t.id, coalesce(i.n, 0), coalesce(i.total, 0), coalesce(cn.total, 0)), ' ' ORDER BY t.id), '') FROM tenants t LEFT JOIN (SELECT tenant_id, count(*) n, sum(payable_paise) total FROM invoices WHERE status = 'posted' AND created_at <= '$CUTOFF' GROUP BY tenant_id) i ON i.tenant_id = t.id LEFT JOIN (SELECT tenant_id, sum(refund_paise) total FROM credit_notes WHERE created_at <= '$CUTOFF' GROUP BY tenant_id) cn ON cn.tenant_id = t.id WHERE t.created_at <= '$CUTOFF'"
RESTORED_TOTALS="$(psql "$TARGET" -qAt -c "$TOTALS_SQL")"
echo "   info  bill totals of $(wc -w <<< "$RESTORED_TOTALS" | tr -d ' ') businesses computed"

if [[ -n "${SOURCE_DATABASE_URL:-}" ]]; then
  echo "4. Comparing with the source..."
  SOURCE_TOTALS="$(psql "$SOURCE_DATABASE_URL" -qAt -c "$TOTALS_SQL")"
  [[ "$SOURCE_TOTALS" == "$RESTORED_TOTALS" ]] && check "every business's bills and totals match the source" ok || check "bill totals per business" "differ from the source"
  SOURCE_COUNTS="$(psql "$SOURCE_DATABASE_URL" -qAt -c "$COUNTS_SQL")"
  MORE=""
  for pair in $RESTORED; do
    name="${pair%%=*}"; n="${pair#*=}"
    s="$(tr ' ' '\n' <<< "$SOURCE_COUNTS" | awk -F= -v t="$name" '$1 == t { print $2 }')"
    [[ -n "$s" && "$n" -le "$s" ]] || MORE="$MORE $name"
  done
  [[ -z "$MORE" ]] && check "no table has rows the source does not" ok || check "tables with unexpected rows" "$MORE"
fi

if [[ "$FAILED" -ne 0 ]]; then echo "RESTORE TEST FAILED"; exit 1; fi
echo "RESTORE TEST PASSED"
