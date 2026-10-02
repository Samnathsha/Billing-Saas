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
4. **Set up your business** (Phase 3 part 3.2c-2): one transaction creates
   the business, settings, default roles, owner membership and audit entry.
5. **Log out** (`POST /api/auth/sign-out`) ends the session at once.

## Security settings (all explicit in the config)

- Passwords: 12–128 characters, Argon2id (19 MiB, 2 passes). Breached-
  password check: Phase 3 step 3.
- Same error for a wrong password and an unknown email.
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

`tests/integration/auth-flow.test.ts` drives the real Better Auth code.
Verified to fail if the cookie cache is switched on, tokens are stored
readable, or the password minimum is lowered.
