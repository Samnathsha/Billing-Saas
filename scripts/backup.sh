#!/usr/bin/env bash
# Nightly encrypted backup (Phase 11; blueprint 13.2). Run by
# .github/workflows/backup.yml; can also be run by hand.
#
#   BACKUP_DATABASE_URL   backup_reader connection (scripts/backup-role.sql)
#   BACKUP_AGE_RECIPIENT  the age PUBLIC key ("age1..."); the private key
#                         stays offline with the owner (docs/backups.md)
#   R2_ENDPOINT, R2_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
#                         private Cloudflare R2 bucket (optional: without
#                         R2_BUCKET the file stays in BACKUP_DIR)
#   BACKUP_DIR            where the encrypted file is written (default
#                         ./backups-out, ignored by Git)
#
# The plain dump exists only in a private temporary folder and is deleted
# before the script ends. Nothing secret is printed.
set -euo pipefail
umask 077

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is not set}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is not set}"
[[ "$BACKUP_AGE_RECIPIENT" =~ ^age1[a-z0-9]{50,}$ ]] || { echo "BACKUP_AGE_RECIPIENT is not an age public key" >&2; exit 1; }

DAY="$(TZ=Asia/Kolkata date +%F)"
MONTH="${DAY:0:7}"
OUT_DIR="${BACKUP_DIR:-./backups-out}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT_DIR"

echo "Dumping the database (pg_dump $(pg_dump --version | awk '{print $3}'))..."
pg_dump --format=custom --compress=9 --no-password --file "$WORK/db.dump" "$BACKUP_DATABASE_URL"

# The archive must be readable and hold the bills' data.
pg_restore --list "$WORK/db.dump" > "$WORK/contents.txt"
grep -q "TABLE DATA public invoices " "$WORK/contents.txt" || { echo "The dump has no invoices data: refusing to keep it." >&2; exit 1; }
echo "Dump OK: $(grep -c "TABLE DATA" "$WORK/contents.txt") tables with data."

age --recipient "$BACKUP_AGE_RECIPIENT" --output "$OUT_DIR/$DAY.dump.age" "$WORK/db.dump"
rm -f "$WORK/db.dump"
echo "Encrypted: $DAY.dump.age ($(du -h "$OUT_DIR/$DAY.dump.age" | cut -f1))."

if [[ -z "${R2_BUCKET:-}" ]]; then
  echo "R2_BUCKET is not set: the encrypted file stays in $OUT_DIR."
  exit 0
fi
: "${R2_ENDPOINT:?R2_ENDPOINT is not set}"
export AWS_DEFAULT_REGION=auto
s3() { aws --endpoint-url "$R2_ENDPOINT" "$@"; }

s3 s3 cp --only-show-errors "$OUT_DIR/$DAY.dump.age" "s3://$R2_BUCKET/daily/$DAY.dump.age"
# The newest copy of each month is also kept as that month's copy.
s3 s3 cp --only-show-errors "$OUT_DIR/$DAY.dump.age" "s3://$R2_BUCKET/monthly/$MONTH.dump.age"
echo "Uploaded daily/$DAY and monthly/$MONTH."

# Keep 30 daily and 12 monthly copies (scripts/lib/backup-prune.ts).
KEYS="$(s3 s3api list-objects-v2 --bucket "$R2_BUCKET" --query 'Contents[].Key' --output text)"
DELETE="$(printf '%s\n' "$KEYS" | npx --no-install tsx scripts/backup-prune.ts "$DAY")"
if [[ -n "$DELETE" ]]; then
  while IFS= read -r key; do
    s3 s3 rm --only-show-errors "s3://$R2_BUCKET/$key"
    echo "Removed old copy $key."
  done <<< "$DELETE"
fi
echo "Backup done."
