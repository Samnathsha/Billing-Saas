# Runbook

One page for running the app (blueprint 13.3-13.5). Keep it short and
current.

## Monitoring (set up with production, Phase 12)

1. **Error monitoring: Sentry (free plan).**
   - Create a Sentry account and a project of type "Next.js".
   - Copy its DSN (Settings → Client Keys). Put it in the hosting
     platform's environment variables as both `SENTRY_DSN` and
     `NEXT_PUBLIC_SENTRY_DSN`, then redeploy.
   - What is sent: the error, where in the code, the page without its
     query, the browser. Never the person, cookies, form data, emails,
     phone numbers, IMEIs, GSTINs or tokens (`src/lib/error-scrub.ts`,
     unit tested).
   - Browser reports go through the app's own `/monitoring` route.
   - In Sentry, set Alerts → "a new issue" → email/app notification.
2. **Uptime.**
   - Create a free monitor at UptimeRobot or Better Stack: HTTPS,
     `https://<your domain>/api/health`, every 5 minutes, keyword
     `"status":"ok"`, alert to your phone (app or SMS).
   - Also set the GitHub repository variable `APP_URL`. The Uptime
     workflow then checks every 15 minutes and emails you on failure.
3. **Backups:** see `docs/backups.md`. A failed nightly run emails you.
4. **Nightly maintenance** (keeps the free database small; migration 0040):
   - Generate a key with `npm run auth:secret`.
   - Set it as `CRON_SECRET` in the hosting platform and as a GitHub
     secret.
   - The hosting platform's cron, or the Maintenance workflow (with
     `APP_URL` set), then calls `/api/maintenance/compact` every night.
   - It removes repeat-protection rows older than 90 days and login
     counters older than 1 day; nothing else.

5. **Daily reconciliation** (Reconcile workflow, 04:00, read-only, uses
   the backup secret): for every business it checks bills against their
   lines, payments, stock movements and customer accounts, returns
   against stock, and stock levels against their full history. A mismatch
   fails the run, which emails you. By hand:
   `npx tsx scripts/reconcile.ts prod [YYYY-MM-DD]`. During the pilot,
   compare its day totals with the shop's own book every evening.

### Alert drill (do once after setup, then every few months)

1. In the hosting platform, set the environment variable
   `HEALTH_DRILL=fail` and redeploy.
2. `/api/health` now answers 503. Within minutes:
   - the uptime monitor alerts your phone;
   - Sentry shows "Health drill: /api/health answered 503 on purpose".
3. Remove `HEALTH_DRILL` and redeploy. The monitor reports "up" again.
4. Note the date below.

## Incidents

**Who decides:** the owner. Write down what happened and when, from the
first sign.

1. **The app is down.**
   - Check the hosting platform's status, then Neon's status page.
   - Redeploy the previous version if the latest deploy caused it.
   - Database problems are fixed forward, or restored (`docs/backups.md`).
2. **A secret leaked** (password, API key, `BETTER_AUTH_SECRET`), or gitleaks
   found one:
   1. Rotate it at once:
      - database passwords: `npx tsx scripts/set-db-passwords.ts` /
        `scripts/set-backup-password.ts`;
      - Resend, R2 and Sentry keys: in their dashboards.
   2. Update the hosting platform and the GitHub secrets.
   3. Rotating `BETTER_AUTH_SECRET` logs everyone out, and two-step login
      must be set up again.
   4. A secret that was committed counts as leaked even if deleted: rotate
      it.
3. **Suspend a business** (abuse, non-payment, a compromised account):
   - Owner database tools only, never from a development session.
   - Set the business's status to `suspended` (the `tenants.status`
     column). Its members can no longer use it; nothing is deleted.
4. **A business asked to be deleted** (Business settings → "Ask to delete
   this business"):
   - It works normally for 30 days, with a banner for everyone. Then nobody
     can enter it.
   - After the date, the operator runs on the operator's computer:
     1. `npx tsx scripts/purge-business.ts prod <business id>`. This
        changes nothing and shows what would go.
     2. Then the same command with `--delete "<exact business name>"`.
   - It runs as migrator, in one transaction. Protections and links are put
     back and checked.
   - Remove the business's photo folder in R2. Note the date here.
   - Backups that still contain it expire with the rotation (at most 12
     months).
5. **A till is lost or stolen:** Tills → Revoke (`docs/offline.md`).
6. **A person's account is misused:**
   - Staff → deactivate (ends all their sessions at once).
   - Or, as that person: Your devices → Log out everywhere, then change
     the password.

## Informing clients

If a business's data may have been exposed:

1. Tell its owner what happened, which data, when, and what was done.
2. Ask the lawyer about the notification duties and deadlines before the
   first paying client (blueprint 13.5).

## Drill log

| Date | Drill | Result |
| --- | --- | --- |
| 2026-10-04 | Restore test (local test database, `scripts/restore-test.sh`) | PASSED: 9,493 businesses, 101,912 bills, totals equal |
| 2026-10-04 | Health drill (local production build, `HEALTH_DRILL=fail`) | `/api/health` 503 `{"status":"drill"}` |
