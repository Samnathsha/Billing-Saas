# Security review (Phase 11)

- Date: 2026-10-04 (commit after `980bcd1`)
- Scope: the whole app (`src/`), database migrations (`drizzle/`), scripts,
  CI (`.github/`).
- Checklists:
  - **OWASP ASVS 4.0.3, Level 1** (every L1 requirement, by chapter);
  - **OWASP Top 10 (2021)**, mapped at the end.
- How: reading the code, plus the automated tests named as evidence (they
  run in CI). Scans: gitleaks (101 commits), Semgrep (142 community rules,
  now in CI), npm audit (runtime clean).

**Result: no open fails.** Gaps found in this review were fixed in Phase 11
(marked **Fixed**). A few items are **Deviations**: a deliberate, smaller
risk with its reason, for the owner to confirm. Items that only exist once
the app is deployed (HTTPS, an external header scan) are **At deployment**
(Phase 12).

Legend: Pass · Fixed (in Phase 11) · Deviation (accepted, reason given) ·
N/A (does not apply) · At deployment (checked in Phase 12).

## V1 Architecture

All V1 requirements are Level 2 or higher. The architecture is in
`docs/blueprint.md` sections 5-8 and `docs/decisions/` (ADRs 0001-0006).

## V2 Authentication

| ID | Requirement (short) | Status | Evidence |
| --- | --- | --- | --- |
| 2.1.1 | Passwords at least 12 characters | Pass | `better-auth.ts` minPasswordLength 12; `auth-flow.test.ts` |
| 2.1.2 | Passwords of 64+ characters allowed (max 128) | Pass | maxPasswordLength 128 |
| 2.1.3 | No truncation | Pass | Argon2id hashes the whole password (`better-auth.ts`) |
| 2.1.4 | Any printable Unicode allowed | Pass | no character rules; `password-strength.test.ts` |
| 2.1.5 | Users can change their password | Pass | Better Auth `/change-password`; `sessions.test.ts` |
| 2.1.6 | Change needs the current and the new password | Pass | `/change-password` body; same test |
| 2.1.7 | Breached passwords refused | Pass | haveIBeenPwned plugin (k-anonymity); `breached-passwords.test.ts` |
| 2.1.8 | Strength meter | **Fixed** | `password-field.tsx`, `lib/password-strength.ts` (+ test) |
| 2.1.9 | No composition rules | Pass | length only |
| 2.1.10 | No forced periodic change | Pass | none |
| 2.1.11 | Paste allowed, password managers work | Pass | no paste blocking; `autocomplete` set on every field |
| 2.1.12 | Option to show the password | **Fixed** | `password-field.tsx` Show/Hide |
| 2.2.1 | Anti-automation on login | Pass | per-IP limits and per-account lockout with growing delay; `rate-limits.test.ts` |
| 2.2.2 | Weak authenticators (SMS, email) not primary | Pass | password + optional TOTP; email only for links |
| 2.2.3 | Notification after credential changes | **Fixed** | `security-notices.ts`: emails on password change/reset and two-step on/off; `two-factor.test.ts` |
| 2.3.1 | Initial passwords random/short-lived | N/A | users choose their own; invitations are links (`invitations.test.ts`) |
| 2.5.1 | Recovery never sends the password | Pass | reset by link only |
| 2.5.2 | No password hints or knowledge questions | Pass | none |
| 2.5.3 | Recovery does not reveal the password | Pass | hashes only |
| 2.5.4 | No shared or default accounts | Pass | none exist |
| 2.5.5 | Notification when a factor changes | **Fixed** | as 2.2.3 |
| 2.5.6 | Secure recovery (time-limited token) | Pass | 1-hour single-use hashed token, logs out everywhere; `auth-flow.test.ts` |
| 2.7.1-2.7.4 | Out-of-band (SMS/push) authenticators | N/A | not used (email links are recovery, 2.5.6) |
| 2.8.1 | Time-based OTPs have a defined lifetime | Pass | TOTP 30-s steps; the code step expires after 10 minutes (`better-auth.ts`) |

## V3 Session management

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 3.1.1 | Session token never in URLs | Pass | HttpOnly cookie only; token endpoints disabled (`better-auth.ts` disabledPaths) |
| 3.2.1 | New token at login | Pass | Better Auth creates a new session; `auth-flow.test.ts` |
| 3.2.2 | At least 64 bits of entropy | Pass | Better Auth random 32-character tokens |
| 3.2.3 | Stored only in secure cookies | Pass | `sessions.test.ts` (HttpOnly, SameSite=Lax) |
| 3.3.1 | Logout invalidates the session on the server | Pass | `auth-flow.test.ts` "logging out ends the session at once" |
| 3.3.2 | Re-authentication periodically | Pass | 30-minute idle and 12-hour absolute timeout (database-capped); `sessions.test.ts` |
| 3.4.1 | Secure attribute | Pass | `useSecureCookies` on https (`session-policy.test.ts`); verified live **At deployment** |
| 3.4.2 | HttpOnly | Pass | `sessions.test.ts` |
| 3.4.3 | SameSite | Pass | Lax; `sessions.test.ts` |
| 3.4.4 | `__Host-` prefix | **Deviation** | Better Auth always uses `__Secure-` on https and cannot use `__Host-`. We set no `Domain` and `Path=/`, so the only gap is a cookie planted by a compromised sibling subdomain; the app will own its domain without other apps on subdomains (Phase 12). |
| 3.4.5 | Path set narrowly | Pass | `Path=/`, the app is the whole site |
| 3.7.1 | Re-authentication before sensitive changes | Pass | password needed to change password or two-step login; sessions over 12 h refused (`sessions.test.ts`) |

## V4 Access control

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 4.1.1 | Enforced on the server | Pass | `requirePermission` first line of every service function (lint rule, `tests/lint/rules.test.ts`); `permissions.test.ts` (5 roles × 14) |
| 4.1.2 | Attributes not changeable by users | Pass | tenant only from the session; strict schemas reject `tenant_id` (`offline-sync.test.ts`, `tenant-isolation.test.ts`) |
| 4.1.3 | Least privilege | Pass | role table (blueprint 5.3); `default-roles.test.ts`; app_user without BYPASSRLS (`check-rls`) |
| 4.1.5 | Fail securely | Pass | unknown permission throws; no plan = no capacity (`plans.test.ts`) |
| 4.2.1 | No access to other records (IDOR) | Pass | forced RLS + composite keys; `tenant-isolation.test.ts` attacks every tenant table |
| 4.2.2 | CSRF protection | Pass | SameSite=Lax + Origin check on every state-changing request (`origin-check.spec.ts`, `proxy.ts`) |
| 4.3.1 | MFA for administrative interfaces | **Deviation** | Two-step login exists and is recommended for Owner and Admin, but is optional as the blueprint (5.2) decided. Owner question: make it compulsory for Owner and Admin? (business rules, open question 49) |
| 4.3.2 | No directory browsing | Pass | Next.js serves no listings |

## V5 Validation, sanitisation and encoding

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 5.1.1 | HTTP parameter pollution | Pass | `formString` takes one value; JSON bodies parsed by strict Zod |
| 5.1.2 | Mass assignment | Pass | `z.strictObject` everywhere; services build their own rows |
| 5.1.3 | Positive input validation | Pass | Zod schemas on every service input |
| 5.1.4 | Structured data strongly typed | Pass | Zod types, regexes for codes, GSTIN, numbers |
| 5.1.5 | Redirects only to allowed places | Pass | `lib/safe-next.ts` (only invitation links) |
| 5.2.1 | HTML input sanitised | Pass | no HTML input is ever rendered as HTML |
| 5.2.2 | Unstructured data sanitised | Pass | lengths and characters limited by schemas |
| 5.2.3 | SMTP/IMAP injection | Pass | emails via Resend's API; fixed subjects and addresses from the database |
| 5.2.4 | No eval / dynamic code | Pass | lint ban (`tests/lint/rules.test.ts`); Semgrep in CI |
| 5.2.5 | Template injection | N/A | no server templates from user input |
| 5.2.6 | SSRF | Pass | the server only calls fixed URLs (Resend, Pwned Passwords) |
| 5.2.7 | SVG / scriptable uploads | Pass | only PNG, JPEG, WebP; re-encoded to WebP (`images.test.ts`) |
| 5.2.8 | Scriptable/template content | N/A | none |
| 5.3.1 | Output encoding for the context | Pass | React escaping; no `dangerouslySetInnerHTML` (lint ban) |
| 5.3.2 | Unicode preserved | Pass | UTF-8 throughout |
| 5.3.3 | XSS protection | Pass | React + CSP with nonces and `strict-dynamic` (`security-headers.spec.ts` blocks injected scripts) |
| 5.3.4 | Parameterised SQL | Pass | Drizzle and `sql` tag only; `sql.raw` and string-built SQL banned (lint) |
| 5.3.5 | ORM without injection | Pass | same |
| 5.3.6 | JSON injection | Pass | `JSON.stringify` / `Response.json` only |
| 5.3.7 | LDAP injection | N/A | no LDAP |
| 5.3.8 | OS command injection | Pass | the app runs no commands |
| 5.3.9 | File inclusion | Pass | no user-chosen paths; random storage keys |
| 5.3.10 | XPath injection | N/A | no XML |
| 5.5.1 | Serialised objects protected | Pass | the till's offline operations are re-validated on the server (`offline-core.ts`) |
| 5.5.2 | XXE | N/A | no XML |
| 5.5.3 | Untrusted deserialisation | Pass | JSON only, then strict Zod |
| 5.5.4 | JSON.parse, never eval | Pass | lint ban on eval |

## V6 Stored cryptography

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 6.2.1 | Crypto fails securely | Pass | well-known libraries only: Argon2id (`@node-rs/argon2`), Better Auth's encryption for TOTP secrets, Node's `crypto` for tokens (`hashTillToken`) |

## V7 Errors and logging

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 7.1.1 | No credentials or session tokens in logs | Pass | errors logged by name/code only (`action-result.ts`, `sync-errors.ts`); `pool-errors.test.ts` (password leak fixed in Phase 7) |
| 7.1.2 | No other sensitive data in logs | Pass | security log stores email hashes, not emails (`rate-limits.test.ts`) |
| 7.4.1 | Generic error message | Pass | "Something went wrong…"; details only in server logs |

## V8 Data protection

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 8.2.1 | Anti-caching for sensitive pages | Pass | `Cache-Control: no-store` on pages and APIs (`security-headers.spec.ts`); the service worker keeps only the till pages and never API answers (`pwa.spec.ts`) |
| 8.2.2 | No sensitive data in browser storage | **Deviation** | A registered till keeps selling prices, GST rates, IMEIs in stock and its recent bills (never costs) in IndexedDB, as the offline design requires (decision 0006; blueprint 8.5). The till's token is useless once revoked; revoking wipes the store. |
| 8.2.3 | Client storage cleared at logout | **Fixed** | logout removes the shop copy, held bills and the kept till page; only unsent bills stay (they must not be lost) (`logout-button.tsx`, `forgetOnLogout`, `sync.test.ts`) |
| 8.3.1 | Sensitive data in bodies/headers, not URLs | Pass | tokens in cookies and headers; CSV query has only dates |
| 8.3.2 | Users can remove or export their data | Pass after step 7 | business export and deletion request (Phase 11 step 7) |
| 8.3.3 | Clear terms for collected data | Pass after step 10 | Privacy Policy draft (Phase 11 step 10), for the lawyer |
| 8.3.4 | Sensitive data identified | Pass | `docs/privacy-data-map.md` (step 10) |

## V9 Communications

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 9.1.1 | TLS everywhere | At deployment | HSTS 2 years sent already; `upgrade-insecure-requests` on https |
| 9.1.2 | Strong cipher suites | At deployment | hosting platform (Phase 12) |
| 9.1.3 | Only TLS 1.2+ | At deployment | hosting platform (Phase 12) |

## V10 Malicious code

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 10.3.1 | Updates integrity | Pass | lockfile with integrity hashes; CI actions pinned by commit |
| 10.3.2 | Subresource integrity / no third-party scripts | Pass | no external scripts at all (CSP `'self'` + nonce) |
| 10.3.3 | Subdomain takeover | At deployment | DNS set up in Phase 12 |

## V11 Business logic

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 11.1.1 | Steps in order | Pass | row locks, sequences, idempotency keys (`sales.test.ts`, `offline-sync.test.ts`) |
| 11.1.2 | Realistic timing | Pass | rate limits on login, codes, exports |
| 11.1.3 | Business limits | Pass | plan limits, discount limits, maximum amounts and lines (schemas) |
| 11.1.4 | Anti-automation against abuse | **Deviation** | Login, two-step codes, password reset and CSV exports are rate limited; every action needs a logged-in member with the right role. General per-user request limits are left to the hosting platform's firewall (Phase 12) for the pilot. |
| 11.1.5 | Business logic limits enforced | Pass | stock never below zero online, credit limits, return windows (tests per module) |

## V12 Files and resources

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 12.1.1 | No huge files | Pass | 2 MB limit before reading; 24 megapixels (`images.test.ts`) |
| 12.3.1 | No paths from user file names | Pass | random storage keys (`files/store.ts`) |
| 12.3.2 | File metadata not trusted | Pass | magic bytes checked; re-encoded to WebP |
| 12.3.3 | Remote file inclusion | N/A | none |
| 12.3.4 | Reflected file download | Pass | CSV `Content-Disposition: attachment` with a fixed name |
| 12.3.5 | Command injection via file names | Pass | no commands |
| 12.4.1 | Files outside the web root | Pass | private storage, served through the app |
| 12.4.2 | Uploaded files scanned | Pass (equivalent) | only images, decoded and re-encoded (nothing else can be uploaded) |
| 12.5.1 | Only allowed file types served | Pass | images as `image/webp` only |
| 12.5.2 | Uploads never run as HTML | Pass | re-encoded images; `nosniff` |
| 12.6.1 | SSRF allow-list | Pass | no user-supplied URLs fetched |

## V13 API

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 13.1.1 | One encoding (JSON, UTF-8) | Pass | |
| 13.1.3 | No sensitive data in API URLs | Pass | till token in a header |
| 13.2.1 | Only allowed HTTP methods | Pass | route files export only their methods (405 otherwise) |
| 13.2.2 | JSON schema validation | Pass | Zod on `/api/sync/operations`; size limit 256 KB |
| 13.2.3 | CSRF for APIs | Pass | Origin check (`origin-check.spec.ts`) |
| 13.3.1 | XML schema | N/A | |

## V14 Configuration

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 14.2.1 | Components up to date, audited | Pass | `npm run audit:runtime` in CI (ADR 0001); Dependabot added (Fixed: `.github/dependabot.yml`) |
| 14.2.2 | Unneeded features removed | Pass | Better Auth token endpoints disabled; no sample pages |
| 14.2.3 | SRI for external assets | Pass | none loaded |
| 14.3.2 | Debug modes off in production | Pass | production build; React overlay CSP only in development |
| 14.3.3 | No version headers | Pass | `X-Powered-By` off (`security-headers.spec.ts`) |
| 14.4.1 | Content-Type with charset | Pass | Next.js `text/html; charset=utf-8`, JSON |
| 14.4.2 | APIs: attachment for downloads | Pass | CSV route |
| 14.4.3 | CSP | Pass | nonce + `strict-dynamic`, no inline scripts, `frame-src`/`object-src` none (Fixed: tightened in step 2) |
| 14.4.4 | nosniff | Pass | |
| 14.4.5 | HSTS | Pass | 2 years, subdomains |
| 14.4.6 | Referrer-Policy | Pass | strict-origin-when-cross-origin |
| 14.4.7 | Framing blocked | Pass | `frame-ancestors 'none'`, `X-Frame-Options: DENY` |
| 14.5.1 | Only needed HTTP methods | Pass | as 13.2.1 |
| 14.5.2 | Origin header not used for authentication | Pass | used only to refuse cross-site requests |
| 14.5.3 | CORS allow-list | Pass | no CORS headers: same origin only |

External header scan (Mozilla Observatory / securityheaders.com): **At
deployment**. It needs a public https address (Phase 12). Expected grade:
A or better; all headers are checked by `security-headers.spec.ts`.

## OWASP Top 10 (2021)

| Risk | Status | Main controls (see the ASVS rows) |
| --- | --- | --- |
| A01 Broken access control | Pass | V4: permissions, forced RLS, isolation tests, CSRF |
| A02 Cryptographic failures | Pass | Argon2id, hashed tokens, encrypted TOTP secrets, HSTS; TLS **At deployment** |
| A03 Injection | Pass | Drizzle only, lint bans, Zod, React escaping, CSP |
| A04 Insecure design | Pass | threat table (blueprint 5.6), ADRs, idempotency, append-only ledgers |
| A05 Security misconfiguration | Pass | headers, CSP, disabled endpoints, no CORS, check-rls in CI |
| A06 Vulnerable components | Pass | audit in CI, Dependabot, pinned actions |
| A07 Identification and authentication failures | Pass | V2/V3: limits, lockout, breached passwords, timeouts, optional two-step login |
| A08 Software and data integrity failures | Pass | lockfile, pinned actions, gitleaks, server re-checks offline data |
| A09 Logging and monitoring failures | Pass (monitoring after step 6) | security log, audit log; error monitoring and uptime check in step 6 |
| A10 SSRF | Pass | no user-supplied URLs fetched |

## Scans (step 1)

- **gitleaks** over all history: no leaks. A deliberate test commit with a
  fake token was blocked by the pre-commit hook.
- **Semgrep** (JavaScript, TypeScript, React, Next.js, OWASP Top 10,
  secrets and GitHub Actions rules): 2 findings, both reviewed (the CI step
  that hides a random throwaway secret from logs). Now runs in CI and fails
  on any new finding. Note: the free rules are thin for React/TSX; the
  project's own lint bans (`tests/lint/rules.test.ts`) cover eval, raw SQL
  and raw HTML.
- **npm audit**: packages the live app uses: clean. Developer tools only:
  `braces` (high, via eslint/shadcn CLI) and `esbuild` (moderate, via
  drizzle-kit). They are reported, not blocking (ADR 0001).
