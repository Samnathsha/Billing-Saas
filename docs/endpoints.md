# Public endpoints

## GET /api/health

Liveness check for uptime monitors and the hosting platform.

- Response: `200` with exactly `{"status":"ok"}`, `Cache-Control: no-store`.
- No login needed. It reveals nothing else (no version, database or system
  details), on purpose.
- It does not check the database. It means "the server process is running".
  A separate readiness check that also tests the database may be added with
  the database phase; it would still return only a status.
- Other methods (`POST`, `PUT`, `PATCH`, `DELETE`) return `405`.

Tests: `src/app/api/health/route.test.ts`, `tests/e2e/health.spec.ts`.
