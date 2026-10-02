# Database setup (Neon)

Two Neon projects: `billing-dev` and `billing-test`. PostgreSQL 18. Each has
the same two roles:

| Role | Used by | Can do | Connection |
|---|---|---|---|
| `neondb_owner` | you, in the Neon console only | everything (Neon superuser, bypasses RLS) | never in `.env.local` |
| `migrator` | drizzle-kit migrations | owns the tables; create/alter tables | direct (no `-pooler`) |
| `app_user` | the running app and tests | read/write rows its grants allow; RLS always applies | pooled (`-pooler`) |
| `auth_service` | the login library only (ADR 0003) | the login tables only; no business table | pooled (`-pooler`) |

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

## Row-level security (migration 0002)

- Every table has RLS **enabled and forced**. Forced means it binds
  `migrator` too: migrations cannot read or change business data (a data fix
  adds a temporary policy inside its own migration).
- The app sets `app.tenant_id` and `app.user_id` per transaction
  (`withTenant`, step 4). Nothing set means no rows.
- Tables with `tenant_id`: rows of the current business only, for reading
  and writing; a row cannot be written with or moved to another business.
- `tenants`: the current business, plus (read-only) businesses the user is
  an active member of. A business can only be created with the id set as the
  current tenant.
- `users`: yourself plus members of the current business; you can change
  only your own account. Login by email and invitations: Phase 3.
- `memberships`: also your own memberships in any business, read-only.
- Migration 0004: those two "across businesses" reads (own memberships, and
  the businesses they belong to) apply **only while no business is set**,
  i.e. at login. Inside a business, nothing of another business shows, even
  if the context mixes business A with a user of business B.
- RLS trusts the context it is given: it limits rows to `app.tenant_id`, but
  does not check that `app.user_id` is a member. That check belongs to the
  session code (Phase 3), the only caller of `createTenantContext`.
- `permissions`: read-only. `rate_limits`: no business data, open to the app.
- `app_user` privileges are granted table by table in the same migration as
  its policy. No DELETE except `roles`, `role_permissions`, `rate_limits`.
- New tenant table checklist: in its migration, run
  `SELECT app_enable_tenant_rls('table');` and grant only the needed
  privileges. `scripts/check-rls.ts` (step 6) fails CI otherwise.

## Append-only tables (migration 0003)

`audit_logs` and `sync_operations` can only grow. Two independent locks:
`app_user` has no UPDATE/DELETE/TRUNCATE right, and triggers refuse those
operations for every role, including `migrator` and a superuser. An insert
trigger sets `created_at` from the database clock, so entries cannot be
backdated. Mistakes are fixed by adding a correcting entry.

New ledger tables (stock movements, party ledger, Phase 6+) call
`SELECT app_make_append_only('table');` in their migration.

## Isolation tests (`tests/isolation`)

Each run creates two full businesses (a row in every tenant table) as
`app_user`. Business A then attacks Business B in every tenant table: read,
read by exact id, count, update, delete, move its own row into B, and insert
a forged row with B's `tenant_id`. Every attack must be refused or affect
zero rows, and B's rows must be unchanged. It also checks: nothing is
visible without a business; businesses and users stay separate; a mixed
context reveals nothing of B; login sees only the user's own businesses.

The list of tenant tables is checked against the database, so a new tenant
table fails the suite until it is added (with a fixture row in
`tests/helpers/business.ts`).

## Using the database in code (`src/db`)

```ts
// In a module's service.ts (ctx comes from the session, Phase 3):
return withTenant(ctx, (tx) => repo.listBranches(tx));
// In repo.ts: queries take the transaction handle, never the raw database.
export function listBranches(tx: TenantTx) { return tx.select().from(branches); }
```

- `TenantContext` can only be made by `createTenantContext()` (validated
  UUIDs, no extra fields). Only the session code calls it.
- `TenantTx` exists only inside `withTenant`, so repositories cannot run
  outside a business.
- `src/db/client.ts` (the pool) may be imported only by `src/db` (lint).
- At startup the app checks it is connected as a restricted `app_user`
  and refuses to start otherwise. An unreachable database only logs a note.
- Tests: `npm test` (no database) and `npm run test:db` (test database,
  `DATABASE_URL_TEST`). Database tests create businesses with random ids;
  the app cannot delete businesses, so these rows build up in the test
  database. That is harmless; the test database can be reset at any time.

Deliberate exceptions to blueprint 6.1:
- `memberships_user_idx` does not start with `tenant_id`: login must find a
  user's businesses before a business is chosen.
- `created_by` has no foreign key (it would tie every module's tables to
  `users`); `audit_logs` is the authoritative record of who did what.
- `audit_logs` and `sync_operations` have no `updated_at`/`version`: their
  rows never change.

## Adding auth_service to an existing setup (Phase 3)

1. Run the latest `scripts/db-roles.sql` in each project's SQL Editor
   (expected: three rows, `app_user`, `auth_service`, `migrator`).
2. Add `OWNER_DATABASE_URL_TEST=<owner connection string from the Neon
   console>` to `.env.local` and run `npx tsx scripts/set-db-passwords.ts test`.
   It sets new passwords for all three roles, adds `AUTH_DATABASE_URL_TEST`
   and removes the `OWNER_` line. Repeat with `_DEV` / `dev`.

## Changing passwords later (rotation)

Add `OWNER_DATABASE_URL_DEV=<owner connection string from the Neon console>`
to `.env.local`, run `npx tsx scripts/set-db-passwords.ts dev`. It sets new
passwords and removes the `OWNER_` line. Same for `test`. Do this at once if a
connection string may have leaked.

## Why passwords are not typed into the SQL Editor

The Neon SQL Editor keeps a history of queries, so a password typed there
stays visible in the console. The script sends the password as a query
parameter instead, and PostgreSQL stores only a SCRAM hash of it.
