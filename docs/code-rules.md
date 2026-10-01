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
