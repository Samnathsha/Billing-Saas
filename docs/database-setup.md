# Database setup (Neon)

Two Neon projects: `billing-dev` and `billing-test`. PostgreSQL 18. Each has
the same two roles:

| Role | Used by | Can do | Connection |
|---|---|---|---|
| `neondb_owner` | you, in the Neon console only | everything (Neon superuser, bypasses RLS) | never in `.env.local` |
| `migrator` | drizzle-kit migrations | owns the tables; create/alter tables | direct (no `-pooler`) |
| `app_user` | the running app and tests | read/write rows its grants allow; RLS always applies | pooled (`-pooler`) |

## One-time setup (per project: do `billing-test` first, then `billing-dev`)

1. **Create the roles.** Neon console → project → **SQL Editor**. Check the
   database is `neondb`. Paste the whole of `scripts/db-roles.sql` and run it.
   Expected: a table with two rows, `app_user` and `migrator`; `can_login` is
   `t`, every other column `f`. Any `ERROR` → stop and ask.
   Do **not** create these roles on Neon's "Roles" page (those become Neon
   superusers).
2. **Set the passwords** from the project folder in the terminal:
   `npx tsx scripts/set-db-passwords.ts test` (or `dev`).
   It needs `.env.local` to hold that project's **owner** connection string in
   `DATABASE_URL_TEST` (or `_DEV`), as it does at first. It generates strong
   passwords, sets them without printing them, checks both roles can log in
   and are restricted, then rewrites `.env.local`:
   `DATABASE_URL_<ENV>` → `app_user` (pooled), `MIGRATOR_DATABASE_URL_<ENV>`
   → `migrator` (direct). The owner connection string is removed.

## Migrations

Tables are defined in `src/modules/<name>/schema.ts`. SQL migrations are
generated into `drizzle/` and committed to Git. They always run as
`migrator`.

| Command | What it does |
|---|---|
| `npm run db:generate` | After changing a `schema.ts`: writes a new SQL file in `drizzle/` (review it before committing) |
| `npm run db:migrate` | Applies new migrations to the dev database |
| `npm run db:migrate:test` | Applies new migrations to the test database |
| `npm run db:check` | Checks the migration files are consistent |

Applied migrations are never edited; a fix is a new migration.

Foundation tables (Phase 2): `tenants`, `users`, `permissions`, `roles`,
`role_permissions`, `memberships`, `branches`, `devices`, `settings`,
`audit_logs`, `sync_operations`, `rate_limits`. `app_user` gets access to
them only together with row-level security (Phase 2 step 3). Full table
descriptions: `docs/schema.md` (Phase 2 step 8).

Deliberate exceptions to blueprint 6.1:
- `memberships_user_idx` does not start with `tenant_id`: login must find a
  user's businesses before a business is chosen.
- `created_by` has no foreign key (it would tie every module's tables to
  `users`); `audit_logs` is the authoritative record of who did what.
- `audit_logs` and `sync_operations` have no `updated_at`/`version`: their
  rows never change.

## Changing passwords later (rotation)

Add `OWNER_DATABASE_URL_DEV=<owner connection string from the Neon console>`
to `.env.local`, run `npx tsx scripts/set-db-passwords.ts dev`. It sets new
passwords and removes the `OWNER_` line. Same for `test`. Do this at once if a
connection string may have leaked.

## Why passwords are not typed into the SQL Editor

The Neon SQL Editor keeps a history of queries, so a password typed there
stays visible in the console. The script sends the password as a query
parameter instead, and PostgreSQL stores only a SCRAM hash of it.
