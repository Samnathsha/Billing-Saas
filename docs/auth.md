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
   password record. No login yet; a verification email is sent. The answer
   is always `{"status":"check-your-email"}`, also for an email that is
   already registered (`uniform-sign-up.ts`), so it reveals nothing.
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

## Screens (step 3.9)

| Page | What it does |
|---|---|
| `/register` | Name, email, password. Always answers "check your email". |
| `/verify-email` | Where the confirmation link lands: "confirmed", or "link did not work" with "send the link again". |
| `/login` | Email, password. Unconfirmed email: offers "send the link again". Link to "forgot password". |
| `/forgot-password` | Email. Always answers "if this address has an account, we sent a link" (valid 1 hour). |
| `/` | Sends you on: not logged in, to `/login`; no business yet, to `/setup`; otherwise to `/dashboard`. |
| `/setup` | "Set up your business": name and shop type (Server Action calling `createBusiness`; business and owner come from the session, never the form). |
| `/dashboard` and every page under `src/app/(app)` | The app frame checks `getRequestContext` on the server for every request (not logged in: `/login`; no business: `/setup`), shows the role and a "Log out" button. Pages and services still check their own permissions. |
| `/reset-password` | Where the reset link lands. New password; on success every device is logged out. Expired, used or refused (e.g. breached password, which still uses up the link): "send a new link" right there. The token is removed from the address bar once the page has it. |

- The forms run in the browser and call `/api/auth/*` through Better
  Auth's browser client (`src/lib/auth-client.ts`), so the per-IP limits,
  Origin check, lockout and uniform answers all apply. (Calling `auth.api`
  from server code would skip the per-IP limiter.)
- Messages are our own fixed texts chosen by error code
  (`src/lib/auth-messages.ts`); the server's wording is never shown.
- `/get-session` is switched off over HTTP too, so page scripts never see a
  session token; pages read the session on the server.

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

## Permissions: `requirePermission(ctx, "...")`

Blueprint 5.3. Every service function starts with
`await requirePermission(ctx, "invoices.void");`. The server decides; the
browser only hides buttons.

- The check reads the member's **current** role from the database each time
  (active membership, active business, role grants the code). Removing a
  permission, changing a role, disabling a member or suspending the business
  works at once, even for a `ctx` made earlier in the same request.
- Refused: `PermissionDeniedError` (`code: "FORBIDDEN"`, message "You do not
  have permission to do this."). Routes will turn it into HTTP 403.
- An unknown permission code is a programming error (plain `Error`), never a
  pass.
- Lint rule for `src/modules/*/service.ts`: every exported function is an
  `export async function name(ctx, ...)` whose first line is
  `await requirePermission(ctx, ...)`. Arrow-function, default, `export { }`
  and `export * from` exports are refused there, and a module's `index.ts`
  may not export `repo.ts`, so nothing can skip the check.
- Exempt by design: `createBusiness` (the user has no business, hence no
  role, yet; its own checks are the gate) and `getRequestContext`.
- The check runs in its own short transaction before the service's work.
  For money and stock writes a later phase may also re-check inside the
  write's transaction.
- Refusals are not logged yet; that comes with the security log for staff
  actions (later).

## Your devices (sessions)

`src/modules/auth/my-sessions.ts`, for the logged-in user only:

- `listMySessions(headers)`: own unexpired sessions as `SessionDto` (id,
  signed-in time, last activity, IP, browser text, `current`). Never a token.
- `endMySession(headers, { sessionId })`: ends one own session; another
  user's id changes nothing and answers `{ ended: false }`, like an unknown
  id. Logged as `auth.session_ended`.
- `logOutEverywhere(headers)`: ends every own session, this one included.
  Logged as `auth.logged_out_everywhere`.
- Not logged in: `NotLoggedInError` (`NOT_LOGGED_IN`).
- Every login creates a new session with a new token (no reuse).
- Better Auth's `/list-sessions` and `/revoke-session` are switched off over
  HTTP (`disabledPaths`): they would hand session tokens to page scripts.

## Staff changes: `src/modules/auth/service.ts`

`changeMemberRole(ctx, { userId, roleId })` and
`deactivateMember(ctx, { userId })`; rules in docs/business-rules.md
section 10. Both start with `requirePermission(ctx, "users.manage")`, lock
the member's row, refuse the Owner (`CANNOT_CHANGE_OWNER`), oneself
(`CANNOT_CHANGE_SELF`) and giving the Owner role (`CANNOT_ASSIGN_OWNER`),
write an audit entry (`member.role_changed`, `member.deactivated`) in the
same transaction, and then end ALL the member's sessions (security log
`auth.sessions_ended_by_admin`). This is the "rotation on role change": the
member logs in again and gets a new session. Even before that, every
request re-reads membership and role. No change (same role, already
disabled) returns `{ changed: false }`. Invitations and screens: Phase 4.

## CSRF (blueprint 5.2)

SameSite=Lax cookies, plus an Origin check on every state-changing request
in `src/proxy.ts` and inside Better Auth (`origin-guard.ts`). The second one
exists because a test showed Better Auth's own check let a cross-site
`POST /sign-out` through. See `docs/endpoints.md`.

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
- `tests/integration/permissions.test.ts`: all 55 role/permission pairs of
  blueprint table 5.3 through `requirePermission`, the safe refusal, unknown
  codes, and that removing a permission, demoting or disabling a member,
  suspending the business, or pairing a user with another business's id is
  refused at once. Verified to fail if the check always passes or ignores
  the membership or business status.
- `tests/lint/rules.test.ts`: the service-function rule refuses a missing,
  late, un-awaited, look-alike or wrong-context check and every export form
  that would dodge it. Verified to fail if the first-line rule is removed.
- `tests/integration/my-sessions.test.ts`: list without tokens, own
  sessions only, new token per login, ending another device at once,
  cannot end someone else's session, strict input, log out everywhere,
  token endpoints off, cross-site logout refused. Verified to fail if the
  origin guard, the owner condition or `disabledPaths` is removed.
- `src/lib/origin-check.test.ts` and `tests/e2e/origin-check.spec.ts`: the
  Origin rule and the proxy on a real server. Verified to fail if the proxy
  check is removed.
- `tests/integration/members.test.ts`: role change and deactivation end
  every session of the member, new login has the new role, audit entries,
  owner/self/owner-role rules, no "Manage users" refused, other business's
  members and roles out of reach, strict input. Verified to fail if any of
  the three rules or either session ending is removed.
- `tests/integration/enumeration.test.ts`: sign-up, login, reset request
  and resend-verification answer identically for unknown, verified and
  unverified emails; signing up again cannot take over an account. Failed
  before the uniform sign-up answer was added (the extra `status` field
  gave existing emails away). Summary of all attack tests:
  docs/security-tests.md.
- `tests/flows/` (`npm run test:flows`): register, confirm by the emailed
  link, log in, cookie HttpOnly and invisible to scripts, `/get-session`
  off, same message for wrong password and unknown email, bad link offers
  a new one. Real browser, own dev server on port 3200, LOCAL throwaway
  database only, emails to `.dev-mailbox/`. Not in CI yet (the CI browser
  job has no database). Verified to fail if `/get-session` is switched on.
  Password reset (`password-reset.spec.ts`): link by email, new password
  works and the old one not, another device is logged out, the link works
  once, token leaves the address bar, same answer for unknown emails.
  Verified to fail if the token stays in the URL or sessions survive.
  Business setup (`business-setup.spec.ts`): first login goes to setup,
  then dashboard with role "Owner"; setup and `/` lead to the dashboard
  afterwards; logout leaves the app; without a login every app page leads
  to `/login`; a blank business name is refused. Verified to fail if the
  app frame's login check is removed.
