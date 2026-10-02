# Attack tests (blueprint Phase 3, item 8)

Where each required attack is tested. The protections were checked by
removing them and seeing these tests fail ("mutation checks", recorded per
test file in docs/auth.md).

| Attack | Expected result | Tests |
|---|---|---|
| Wrong-password flood | Per account: after 5 failures, growing wait (even with the right password). Per IP: 10 logins per minute. | `tests/integration/rate-limits.test.ts` |
| User enumeration | Sign-up, login, password reset and resend-verification answer exactly the same for unknown, verified and unverified emails. | `tests/integration/enumeration.test.ts`, `rate-limits.test.ts` (lockout for unknown emails) |
| Revoked session reused | Stops at once: ended device, log out everywhere, logout, idle and 12-hour timeout, role change or deactivation by an admin. | `my-sessions.test.ts`, `sessions.test.ts`, `members.test.ts` |
| Cashier calls an owner-only action | `FORBIDDEN` before anything happens. All 55 role/permission pairs of table 5.3. | `permissions.test.ts`, `members.test.ts` |
| Tenant A uses Tenant B's session or ids | Forged session business is replaced by the real one; forged context gets no permission; B's members and roles are "not found" for A; database row security blocks every table. | `onboarding.test.ts`, `permissions.test.ts`, `members.test.ts`, `tests/isolation/*` |
| Cross-site request (CSRF) | Any write without our Origin: `403`, on pages, API routes and login endpoints. | `src/lib/origin-check.test.ts`, `tests/e2e/origin-check.spec.ts`, `my-sessions.test.ts` |
| Session token theft through page scripts | Cookie is HttpOnly; no endpoint returns other sessions' tokens. | `sessions.test.ts`, `my-sessions.test.ts` |
| Account takeover by signing up again | Existing account keeps its password and verification. | `enumeration.test.ts` |

Not yet covered (comes with its feature):
- Owner-only **pages**: `/settings/staff` shows "Not allowed" to a cashier
  (`tests/flows/devices-and-roles.spec.ts`). The page still answers HTTP
  200 with that text: Next.js's `forbidden()` (a real 403) is experimental
  in this version. Owner-only **API calls** (for the browser's network tab)
  arrive with staff management in Phase 4; the service check underneath is
  tested.
- Response **timing** for known vs unknown emails is not measured (too
  noisy for automated tests). Sign-up for an existing email may answer at a
  slightly different speed; the per-IP limits make measuring it slow.
  Review again before launch.
