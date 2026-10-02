# 0003: How Better Auth reaches the database

- Status: Accepted
- Date: 2026-10-01
- Decided by: owner (Phase 3, part 3.2a)
- Builds on: [0002](0002-auth-library.md) (Better Auth)

## Context

Better Auth runs its own queries (find user by email, check password, find
session by token) before any business is chosen. Our RLS blocks exactly
that for `app_user`, by design. Rejected alternatives:

- A "bypass" setting the library sets per transaction: `app_user` could set
  it too, so any app code could bypass RLS.
- Routing every auth query through reviewed SECURITY DEFINER functions:
  not possible with a library's generic adapter.

## Decision

1. **New role `auth_service`**, used only by Better Auth, on its own
   connection (`AUTH_DATABASE_URL_DEV` / `_TEST`, pooled). Created by
   `scripts/db-roles.sql`; password set by `scripts/set-db-passwords.ts`.
   Same restrictions as `app_user` (no superuser, BYPASSRLS, CREATEROLE,
   CREATEDB; owns nothing).
2. **auth_service reaches only the auth tables**: `users`, `sessions`,
   `accounts`, `verifications`, `rate_limits` (full use) and
   `security_events` (insert only). Policies `TO auth_service` exist only on
   those tables. It has **no privilege on any business table**.
   `check-rls` enforces both.
3. **app_user has no access** to `sessions`, `accounts` (password hashes),
   `verifications` (tokens) or `security_events`. Its access to `users` and
   `rate_limits` is unchanged.
4. **Tables** (migration in 3.2b):
   - `users` becomes Better Auth's user table: `email_verified` (boolean)
     replaces `email_verified_at`; optional `image`; `status` kept (a
     disabled user cannot log in and all sessions are revoked).
   - `sessions`: token, user, expiry, IP, user agent, `active_tenant_id`
     (not `tenant_id`: a session belongs to a person; the business is
     re-checked on every request).
   - `accounts`: password hash (Argon2id). `verifications`: single-use,
     expiring tokens.
   - `rate_limits`: reshaped to Better Auth's format (unused until now).
   - `security_events`: append-only, no business (failed logins etc.);
     review question R6.
5. **Every request**: Better Auth resolves the session (cookie cache off,
   so revocation is immediate) → our code confirms an **active membership**
   for `(user, active_tenant_id)` as `app_user` → only then
   `createTenantContext()` → `withTenant()`.
6. **Registration**: Better Auth creates user + password; then ONE
   `app_user` transaction creates the business, settings, default roles and
   permissions, owner membership and audit entry. If that step fails, the
   user finishes "Set up your business" after logging in. Login requires a
   verified email.

## Consequences

- A compromise of Better Auth or its connection exposes login data, never
  business data; the database enforces it.
- One more role and connection string per database.
- One extra query per request (membership check), which also makes
  removing a membership take effect immediately.
