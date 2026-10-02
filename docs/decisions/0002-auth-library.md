# 0002: Authentication library: Better Auth

- Status: Accepted
- Date: 2026-10-01
- Decided by: owner, on the agent's recommendation (Phase 3, step 1)

## Context

Blueprint 3 and 5.2 require a maintained library (no hand-written session,
token or crypto code) providing email/password login, email verification,
password reset, server-side revocable sessions with rotation and timeouts,
a session list with "log out everywhere", rate limiting, Argon2id and a
breached-password check. Candidates: Better Auth and Auth.js.

Checked on 2026-10-01 (npm registry and official docs):

- Better Auth 1.7.7 (stable, published 2026-09-30). Peer support for
  Next.js 14–16, drizzle-orm 0.45, pg 8. Email/password, verification,
  reset, database sessions (`listSessions`, `revokeSession`,
  `revokeOtherSessions`, `revokeSessions`, `expiresIn`, `updateAge`), a
  built-in rate limiter with database storage, a Have I Been Pwned plugin
  (k-anonymity: only 5 hash characters leave the server), and a custom
  password hash hook. Default hash is scrypt.
- Auth.js: v5 for current Next.js is `5.0.0-beta.32`; stable `next-auth`
  is v4. Its Credentials provider docs recommend against email/password
  and leave hashing, rate limiting, reset and verification to the app.

## Decision

Use Better Auth, with:

1. Argon2id via its password hash hook, using `@node-rs/argon2`
   (prebuilt, maintained). Minimum password length 12.
2. The Have I Been Pwned plugin.
3. Database sessions with the cookie cache **disabled**, so a revoked session
   stops working at once (the cache would delay revocation up to its max age).
4. Its rate limiter with database storage, enabled in every environment
   (it is off in development by default).
5. Its tables mapped onto our schema and protected by RLS; the narrow
   database access it needs before a business is chosen (lookup by email,
   session lookup by token) is designed and reviewed in Phase 3 step 2.

## Consequences

- Login, sessions and tokens come from a maintained library; our code adds
  tenancy, permissions and audit on top.
- Better Auth expects its own tables (user, session, account,
  verification). Mapping them onto `users` and adding `sessions` etc. is a
  migration in Phase 3.
- Upgrades of Better Auth are security-relevant: read its release notes,
  run the full test suite (including isolation tests) before merging.
