# Deploying (Phase 12)

The app runs as one container (`Dockerfile`, Node 24, self-contained Next.js
server, runs as an unprivileged user). The host chosen in decision 0007
runs it. **Staging** and **production** are two separate deployments: each
has its own Neon project, its own secrets and its own address. They share
nothing.

## Settings (the host's environment variables)

`APP_ENV` marks a real deployment. With it, the app refuses to start if any
developer setting (`DATABASE_URL_DEV`, `..._TEST`, `MIGRATOR_...`,
`OWNER_...`) is present. It also refuses an http address and missing email
settings.

| Variable | Staging | Production | Notes |
| --- | --- | --- | --- |
| `APP_ENV` | `staging` | `production` | |
| `DATABASE_URL` | staging app_user (pooled) | production app_user (pooled) | from `scripts/set-db-passwords.ts`, never the owner role |
| `AUTH_DATABASE_URL` | staging auth_service | production auth_service | |
| `BETTER_AUTH_SECRET` | its own random value | its own random value | `npm run auth:secret`; never the same twice |
| `BETTER_AUTH_URL` | `https://staging.<domain>` | `https://app.<domain>` | must be https |
| `RESEND_API_KEY`, `EMAIL_FROM` | a Resend key | a separate Resend key | sender on your domain |
| `CRON_SECRET` | random | random | nightly maintenance (runbook) |
| `SENTRY_DSN` | optional | the production project's DSN | |
| `NEXT_PUBLIC_SENTRY_DSN` | build argument | build argument | public, set at build |

Migrations are not run by the app. Run them as migrator from your computer
with that environment's `MIGRATOR_DATABASE_URL`, before deploying the code
that needs them (blueprint 13.4).

## Before every deploy

`npm run predeploy`. It must end with "Ready to deploy". It runs:

1. typecheck, lint, unit tests;
2. the database tests (local test database);
3. the row-level security check;
4. the runtime audit;
5. the secret scan over the whole history;
6. Semgrep, if installed.

## Fly.io (recommended in decision 0007)

Once, on your computer:

1. Install flyctl and log in (`fly auth login`).
2. `fly launch --no-deploy --region sin` in the project folder. It finds
   the Dockerfile. Name the app, for example `billing-staging`; choose 1 GB
   of memory.
3. Set the settings: `fly secrets set APP_ENV=staging DATABASE_URL=... ...`.
   Type them into the terminal yourself; never paste them into a chat.
4. `fly deploy`. Then open `https://<app>.fly.dev/api/health`; it must say
   `{"status":"ok"}`.
5. Your domain: `fly certs add staging.<domain>`. At your domain registrar,
   add the DNS records it prints. Then set `BETTER_AUTH_URL` to that https
   address.

Repeat with a second app (`billing-prod`) and production settings for
production.

**Roll back:** `fly releases`, then `fly deploy --image <previous image>`.
Database changes are never rolled back. They are fixed forward or restored
(`docs/backups.md`).
