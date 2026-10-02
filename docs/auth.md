# Login and sessions (Phase 3)

Library: Better Auth (ADR 0002), on its own database role `auth_service`
(ADR 0003). Configuration: `src/modules/auth/better-auth.ts`.

## Settings (`.env.local`)

| Name | What | How to set |
|---|---|---|
| `AUTH_DATABASE_URL_DEV` / `_TEST` | auth_service connection | `npx tsx scripts/set-db-passwords.ts dev` / `test` |
| `BETTER_AUTH_SECRET` | signing key (32+ chars) | `npm run auth:secret` (never printed). `-- --rotate` replaces it and logs everyone out |
| `BETTER_AUTH_URL` | the app's address | `npm run auth:secret` sets `http://localhost:3000` |
| `RESEND_API_KEY`, `EMAIL_FROM` | real email sending | you, in `.env.local` (sending-only key from Resend) |

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

- Passwords: 12–128 characters, Argon2id (19 MiB, 2 passes).
- Breached-password check (Have I Been Pwned plugin) on sign-up, password
  change and reset: only the first 5 characters of the password's SHA-1
  hash leave the server, with padded replies. If the service cannot be
  reached, the action is refused ("try again later"), never let through.
  Logins do not call it. Note for the reset screen: a reset link is used
  up even when the new password is refused, so the screen must offer
  "send a new link".
- Same error for a wrong password and an unknown email.
- A disabled account cannot start a session (`databaseHooks`).
- Sessions in the database; cookie cache **off**, so logout, revoke and
  password reset take effect on the very next request.
- Timeouts (owner decision 2026-10-02, `session-policy.ts`):
  - **Idle 30 minutes**: a session expires 30 minutes after last use; use
    extends it at most every 5 minutes (so the cut-off is 25–30 minutes).
  - **Absolute 12 hours** from login, even if active. Enforced by the
    database (migration 0008 caps `expires_at` at `created_at + 12 h`, so
    every Better Auth endpoint refuses the session too) and again by
    `getRequestContext`, which deletes it.
- Cookie `billing.session_token`: HttpOnly, SameSite=Lax, Path=/, Max-Age
  30 minutes, and Secure whenever the app runs on https:// (production).
- Verification and reset tokens stored hashed; reset link valid 1 hour,
  single use; a reset logs the account out everywhere.
- **Per-IP limits** (Better Auth's limiter, in `rate_limits`, on in every
  environment): sign-in 10/min, sign-up 10/h, password-reset requests 5/h,
  reset 10/h, verification emails 5/h, change password 10/h, everything
  else 100/min. Requests without a usable IP share one bucket (never
  unlimited). Deployment note: set the correct client-IP header for the host
  (e.g. `cf-connecting-ip` on Cloudflare) in `advanced.ipAddress`, or an
  attacker could fake their IP.
- **Per-account limit** (`account-lockout.ts`, `lockout-policy.ts`): 5 free
  wrong passwords per email; then each attempt waits 1, 2, 4, 8, up to 15
  minutes after the last failure, even with the right password. Cleared by a
  successful login, forgotten 1 hour after the last failure. Counted for
  unknown emails exactly as for real ones, with the same "Too many
  requests" message as the IP limiter, so nothing reveals which emails
  exist.
- **Security log** (`security_events`): `auth.login_failed`,
  `auth.login_locked` (email stored only as a SHA-256 hash) and
  `auth.login_succeeded` (user id), with IP and browser. IDs are UUIDs.

## Emails

| Where | What happens |
|---|---|
| Tests | Kept in memory; never sent |
| Development with `RESEND_API_KEY` + `EMAIL_FROM` | Sent through Resend |
| Development without them | Saved as files in `.dev-mailbox/` (git-ignored) |
| Production | Sent through Resend; the app refuses to start without both settings |

- `src/modules/auth/resend.ts`: one HTTPS call to Resend's API (no extra
  package), 10-second timeout, a fresh `Idempotency-Key` per email. Errors
  say only the status code; never the key or the link.
- Use a **sending-only** ("restricted") Resend key: it can send but cannot
  read or change the account.
- `EMAIL_FROM=onboarding@resend.dev` is Resend's test sender: it delivers
  only to the email address of your own Resend account. Before launch,
  verify your domain in Resend and use e.g. `Shop <noreply@yourdomain.in>`.

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
- `tests/integration/rate-limits.test.ts`: lockout even with the right
  password, identical behaviour for unknown emails, growing wait, clearing,
  forgetting, parallel attempts, security log without plain emails, per-IP
  limits over HTTP. Verified to fail if the plugin or the IP rules are
  removed.
- `tests/integration/sessions.test.ts`: cookie attributes from a real
  sign-in response, idle expiry and extension, 12-hour cut-off (also for
  Better Auth's own endpoints and change-password). Verified to fail if the
  database cap is removed.
- `tests/integration/breached-passwords.test.ts`: breached password refused
  on sign-up and reset, service-down refuses, only the hash prefix is sent,
  login unaffected. Uses a stand-in for the HIBP service
  (`tests/helpers/hibp.ts`), so tests never need the internet. Verified to
  fail if the plugin is removed.
