# Backups (Phase 11)

Blueprint 13.2. Three layers:

1. **Neon's own history** (6 hours on the free plan) for "I just broke
   something".
2. **A nightly encrypted copy** made by GitHub Actions
   (`.github/workflows/backup.yml`, 02:00 India time) into a private
   Cloudflare R2 bucket. It keeps **30 daily and 12 monthly copies**.
3. **A monthly restore drill**: restore the newest copy into an empty
   database and check it (`scripts/restore-test.sh`).

## How it works

- `scripts/backup-role.sql` creates **backup_reader**. It is read-only
  (`pg_read_all_data`) but may see every business's rows (BYPASSRLS).
  Row-level security hides other businesses' rows from every other role,
  and a backup must contain them all. A backup taken as the app's own role
  fails instead of silently missing rows (checked).
- `scripts/backup.sh`:
  1. runs `pg_dump` (version 18, like Neon);
  2. checks the file can be read and holds the bills;
  3. encrypts it with **age** to the owner's PUBLIC key;
  4. deletes the plain copy;
  5. uploads `daily/YYYY-MM-DD.dump.age` and `monthly/YYYY-MM.dump.age`;
  6. removes copies older than 30 days and 12 months
     (`scripts/lib/backup-prune.ts`, unit tested). Nothing else in the
     bucket is touched.
- Only the owner's **private** key can open a copy. It is never in Git,
  GitHub or the app.

## Tested (2026-10-04, local test database)

- Backup as backup_reader: 52 tables, encrypted (59 MB with the 50,000-bill
  speed-test data).
- Restore drill into a new empty database: 51 tables, migration history,
  9,493 businesses, 101,912 bills. For every business, the bills, their
  totals and the credit notes are exactly the same as the source. No table
  has rows the source does not. **RESTORE TEST PASSED**.
- Backup as app_user: refused by the database (no file kept).

## One-time setup (owner, with production in Phase 12)

Do this in your own accounts; never paste a key or password into a chat.

1. **Keys.** In the Terminal on your computer:
   `age-keygen -o billing-backup-key.txt`. It prints the public key
   (`age1…`). Keep `billing-backup-key.txt` (the private key) in your
   password manager AND print it on paper. Without it, the backups cannot
   be opened. Delete the file from the computer afterwards.
2. **Cloudflare R2 (free tier).**
   - Create a bucket `billing-backups`. It stays private: no public
     access, no custom domain.
   - Create an R2 API token with "Object Read & Write" on that bucket
     only. Note the Access Key ID, the Secret Access Key and the account's
     S3 endpoint (`https://<account-id>.r2.cloudflarestorage.com`).
3. **Backup role.**
   - In the Neon console (production project), SQL Editor, as
     neondb_owner: paste `scripts/backup-role.sql` and press Run.
   - Then add `OWNER_DATABASE_URL_PROD=<owner connection string>` to
     `.env.local` and run `npx tsx scripts/set-backup-password.ts prod`.
     It writes `BACKUP_DATABASE_URL_PROD` and removes the owner line.
4. **GitHub** (repository → Settings → Secrets and variables → Actions):
   - Secrets: `BACKUP_DATABASE_URL` (the value from step 3; then delete
     that line from `.env.local`), `R2_ACCESS_KEY_ID`,
     `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`.
   - Variables: `R2_BUCKET` = `billing-backups`, `BACKUP_AGE_RECIPIENT` =
     the public key `age1…`.
5. **First run.** Actions → Backup → Run workflow. It must end green and
   the bucket must show `daily/…` and `monthly/…`.

If the job fails, GitHub emails the repository owner.

## Monthly restore drill (about 10 minutes)

1. Download the newest `daily/….dump.age` from the R2 bucket (Cloudflare
   dashboard).
2. Restore it into a **non-production** server. Your computer's test
   PostgreSQL works, or a Neon branch of a non-production project. Run:

   ```text
   AGE_IDENTITY_FILE=<path to the private key file> \
   RESTORE_ADMIN_URL=<connection that may create databases> \
   SOURCE_DATABASE_URL=<backup_reader connection to production> \
   scripts/restore-test.sh <downloaded file>
   ```

3. It must end with **RESTORE TEST PASSED**. Note the date and result in
   `docs/runbook.md`. Then remove the downloaded file and the key file from
   the computer.
