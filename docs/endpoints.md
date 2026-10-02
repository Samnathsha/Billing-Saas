# Public endpoints

## Every state-changing request: Origin check

`POST`, `PUT`, `PATCH`, `DELETE` (any method except `GET`, `HEAD`,
`OPTIONS`) must carry `Origin` exactly equal to the app's address
(`BETTER_AUTH_URL`). Otherwise: `403 {"message":"Request refused."}`,
before any page, route or login endpoint runs. Applied by `src/proxy.ts` to
every page and `/api/*`, and again inside Better Auth
(`src/modules/auth/origin-guard.ts`). A future device API that does not use
cookies may need its own rule (decide then, with an ADR).

## /api/auth/* (Better Auth)

Login, logout, sign-up, verification, reset, change password. Switched off
(`404`): `/list-sessions` and `/revoke-session`, because they send or take
session tokens; the app's own session functions replace them.

## GET /api/health

Liveness check for uptime monitors and the hosting platform.

- Response: `200` with exactly `{"status":"ok"}`, `Cache-Control: no-store`.
- No login needed. It reveals nothing else (no version, database or system
  details), on purpose.
- It does not check the database. It means "the server process is running".
  A separate readiness check that also tests the database may be added with
  the database phase; it would still return only a status.
- Other methods (`POST`, `PUT`, `PATCH`, `DELETE`) return `405` (or `403`
  first, if they come without our Origin; see below).

Tests: `src/app/api/health/route.test.ts`, `tests/e2e/health.spec.ts`.
