# Login and sessions (Phase 3)

Library: Better Auth (ADR 0002), on its own database role `auth_service`
(ADR 0003). Configuration: `src/modules/auth/better-auth.ts`.

## Settings (`.env.local`)

| Name | What | How to set |
|---|---|---|
| `AUTH_DATABASE_URL_DEV` / `_TEST` | auth_service connection | `npx tsx scripts/set-db-passwords.ts dev` / `test` |
| `BETTER_AUTH_SECRET` | signing key (32+ chars) | `npm run auth:secret` (never printed). `-- --rotate` replaces it and logs everyone out |
| `BETTER_AUTH_URL` | the app's address | `npm run auth:secret` sets `http://localhost:3000` |

## Flow

1. **Sign up** (`POST /api/auth/sign-up/email`): creates the user and the
   password record. No login yet; a verification email is sent.
2. **Verify** the email with the link (valid 24 hours).
3. **Log in** (`POST /api/auth/sign-in/email`). Refused until verified.
4. **Set up your business** (`createBusiness` in
   `src/modules/auth/onboarding.ts`): for a logged-in, verified, active user
   with no business. ONE transaction, under a per-user lock (a double click
   cannot create two), creates the business, settings, a "Main branch", the
   five default roles with the blueprint 5.3 permissions
   (`default-roles.ts`), the owner membership and a `business.created` audit
   entry. Input is strict: an extra field such as a forged `tenantId` is
   rejected. V1: one business per user.
5. **Log out** (`POST /api/auth/sign-out`) ends the session at once.

## Every request: `getRequestContext(headers)`

`src/modules/auth/request-context.ts` is the only place a request gets a
business context:

1. Better Auth checks the session cookie in the database (no cache).
2. The user must be active and verified; otherwise the request is anonymous.
3. The session's chosen business is **re-checked against an active
   membership** in an active business. If it fails (forged, removed or
   disabled), it is cleared; in V1 the user's only business is used instead,
   if there is one.
4. Only then is a `TenantContext` made, and the role's permissions loaded.

Result: `anonymous`, `no-business` (logged in, no usable business) or
`member` (with `ctx`, `roleName`, `permissions`). A disabled account or
membership loses access on the very next request. Only the auth module may
call `createTenantContext` or `withUserTransaction` (lint rule).

## Security settings (all explicit in the config)

- Passwords: 12–128 characters, Argon2id (19 MiB, 2 passes). Breached-
  password check: Phase 3 step 3.
- Same error for a wrong password and an unknown email.
- A disabled account cannot start a session (`databaseHooks`).
- Sessions in the database; cookie cache **off**, so logout, revoke and
  password reset take effect on the very next request. 7-day absolute
  limit, refreshed daily (timeouts finalised in Phase 3 step 4).
- Verification and reset tokens stored hashed; reset link valid 1 hour,
  single use; a reset logs the account out everywhere.
- Rate limiting on in every environment, stored in the database (tuned in
  Phase 3 step 5). IDs are UUIDs.

## Emails in development

Until an email provider is added (part 3.2d), development emails are saved
as files in `.dev-mailbox/` (git-ignored): open the newest file to click
the link. Tests keep emails in memory. Production refuses to send without a
real provider.

## Tests

- `tests/integration/auth-flow.test.ts` drives the real Better Auth code.
  Verified to fail if the cookie cache is switched on, tokens are stored
  readable, or the password minimum is lowered.
- `tests/integration/onboarding.test.ts`: business creation, roles, request
  context, double click, per-user lock, forged session business, disabled
  membership and account, cashier permissions, strict input. Verified to
  fail if the lock, the membership re-check or the disabled-account hook is
  removed.
- `src/modules/auth/default-roles.test.ts` restates blueprint table 5.3.
