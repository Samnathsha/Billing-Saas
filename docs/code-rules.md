# Code rules enforced by tools

These rules from CLAUDE.md are checked automatically. `npm run lint` fails
if any is broken, and `tests/lint/rules.test.ts` proves each rule works.

## TypeScript (tsconfig.json)

`strict` plus `noUncheckedIndexedAccess`, `noImplicitOverride`,
`noImplicitReturns` and `noFallthroughCasesInSwitch`. Reading `list[0]` gives
a value that may be `undefined`, so the code must handle a missing item.

## Lint (eslint.config.mjs)

- typescript-eslint `strictTypeChecked`: catches unhandled promises, unsafe
  `any`, and similar bugs.
- `eslint-disable` comments are ignored. A rule can only be changed in
  `eslint.config.mjs`, where the change is visible in review.
- `no-console`: only `console.error` is allowed until the logger exists.

## Who may import what

| Folder | May import | Must not import |
|---|---|---|
| `src/app` | `@/modules/<name>`, `@/components`, `@/lib` | `@/db`, `pg`, `drizzle-orm`, module internals |
| `src/components` | `@/components`, `@/lib`, module **types** | module code, `@/db`, `@/app` |
| `src/modules/<name>` | own files (`./x`), other modules' index, `@/db/with-tenant`, `@/lib` | other modules' files, `@/app`, `@/components`, `@/db/client`, `pg` |
| `src/modules/*/service.ts` etc. | as above | `drizzle-orm` values (types are fine). Queries go in `repo.ts`. |
| `src/db` | `pg`, `drizzle-orm`, `@/lib` | `@/modules`, `@/app`, `@/components` |
| `src/db/schema` | as `src/db`, plus `@/modules/<name>/schema` | other module files |
| `src/lib` | nothing above it | `@/modules`, `@/db`, `@/app`, `@/components`, `pg`, `drizzle-orm` |

Imports outside the current folder use the `@/` alias, never `../`, so the
rules above cannot be bypassed with relative paths.

## Environment settings

`src/lib/env.ts` validates settings with Zod; code imports `env` from there
and never reads `process.env` directly. `src/instrumentation-node.ts` loads it
when the server starts, so a missing or malformed setting stops the app with a
message such as `DATABASE_URL_DEV is missing`. Messages name the variable,
never its value.

| Mode (`NODE_ENV`) | Required | Used for |
|---|---|---|
| development (`npm run dev`) | `DATABASE_URL_DEV` | your local database |
| test (`npm test`) | `DATABASE_URL_TEST` | the test database |
| production (`npm run build && npm start`) | `DATABASE_URL_DEV`, **for now** | local production builds only; the deployment phase adds a separate production variable |

Both URLs must start with `postgres://` or `postgresql://`, and must point to
different databases, so tests can never wipe development data. An empty value
counts as missing. `env.ts` uses `server-only`, so the build fails if browser
code imports it.

## Security headers

Fixed headers on every response (`next.config.ts`, from
`src/lib/security-headers.ts`): HSTS (2 years, subdomains, no preload yet),
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, and a `Permissions-Policy`
that turns off camera, microphone, location, payment, USB and similar
features. `X-Powered-By` is removed.

Content Security Policy: `src/proxy.ts` makes a new random nonce for every
page request. Scripts and `<style>` blocks run only if they carry it, so
injected scripts are blocked. Consequences:

- Every page renders per request (the root layout calls `connection()`).
  Pages cannot be pre-built or cached by a CDN.
- `style="..."` attributes are allowed (`style-src-attr 'unsafe-inline'`)
  because a nonce cannot cover them and Next.js itself uses them. They can
  change looks only, never run code.
- Development mode also allows `eval` and inline `<style>`, which React's
  error overlay needs. Production does not.
- A third-party script or font (analytics, payment widget, Google Fonts at
  runtime) will be blocked until its address is added to the policy on
  purpose.
- API routes get `default-src 'none'; frame-ancestors 'none'`.

`tests/e2e/security-headers.spec.ts` checks all of this in a real browser
(`npm run test:e2e`), including that a script injected into the HTML is
blocked.

## Banned code

- `dangerouslySetInnerHTML`, writing `innerHTML`/`outerHTML`,
  `insertAdjacentHTML`, `document.write`, `eval`, `new Function`.
- SQL built from strings: template strings or `+` that start with a SQL word,
  built strings passed to `query()`/`execute()`, and `sql.raw()`.
  Use Drizzle's query builder, or the tagged `` sql`... ${value}` `` form,
  which sends values as parameters.

The SQL check is a pattern match, so it can miss unusual code (for example a
query string built in pieces across several variables). Code review and the
database permission tests remain the main protection.
