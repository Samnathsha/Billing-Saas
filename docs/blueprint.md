# Multi-Tenant Billing & Inventory SaaS — Master Blueprint

Oct 1, 2026 · @jeri

## 1. Summary and key decisions

This plan builds one hosted, multi-tenant billing, POS and inventory app that costs $0 until your first paying client, with security designed in from day one. It replaces your two conflicting drafts (MongoDB and FastAPI/PostgreSQL) with one consistent design.

Two honest points up front. First, no software is ever "zero bugs"; what this plan gives you is a set of automated gates (tests, isolation proofs, security scans) that stop most defects before a real user sees them. Second, "$0" holds for development and a pilot; the free plans that allow commercial use have limits, and one popular host (Vercel Hobby) forbids commercial use. Section 4 covers this.

| Decision | Choice | Why |
| --- | --- | --- |
| Database | PostgreSQL (not MongoDB) | Money and stock need foreign keys, constraints, true transactions and row-level security. MongoDB has none of the last two in a usable form. |
| Language | TypeScript only: Next.js full-stack | One language, one repo, one deploy. Your master prompt asked for Python FastAPI; that adds a second host, a second test setup and cold-start problems on free hosts. |
| Tenancy | One database, shared tables, `tenant_id` on every row, plus Postgres Row-Level Security | Cheapest option; RLS means a coding mistake still cannot leak another client's data. |
| Offline | Designed in from day 1, built in Phase 9 | Needs client-generated IDs and idempotency keys from the first sale endpoint, or it cannot be added safely later. |
| Build style | 13 small phases, each with tests and a sign-off | Prevents the "thousands of files at once" failure. |
| Dev cost | $0 | Free tiers of Neon, GitHub, Cloudflare R2 and free email. |

If you would rather keep Python FastAPI, tell me and I will redo Sections 3, 9 and 11 for it. I recommend against it for a non-developer owner on a $0 budget.

## 2. Review of your notes: conflicts and gaps

I read every section of your notes. Your Core V1 list, business flows and master prompt are solid; the problems are mismatches between them and several rules that were never decided. Each is resolved below, and the resolution is built into the later sections.

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | Two different stacks: Next.js + MongoDB Atlas + Mongoose (early notes) vs Next.js + FastAPI + SQLAlchemy + PostgreSQL (master prompt). | PostgreSQL. One language (TypeScript). See Section 3. |
| 2 | Early collection list has no tenants, roles, stock balances, returns, audit logs or sync tables. Multi-tenancy cannot work without a `tenants` table and `tenant_id` everywhere. | Use the merged entity list in Section 6. |
| 3 | "payments" is ambiguous: money a customer pays on an invoice, or money a business pays you for the subscription. | Split into `invoice_payments` and `subscription_payments`. |
| 4 | ACID listed as a feature, but MongoDB transactions need a replica set and have no row-level security. | Solved by PostgreSQL transactions plus RLS. |
| 5 | No rule for money storage. Floating-point numbers cause rounding errors in invoices. | Store all money as integer minor units (paise/cents) in `bigint`. Section 7. |
| 6 | No invoice numbering rule. Tax authorities usually require unbroken sequences. | Per-tenant, per-series counter updated inside the sale transaction. Section 7. |
| 7 | Cancelling or editing a posted invoice is undefined. | Posted invoices are never edited or deleted; only voided with a reason, creating reversing stock and payment entries. |
| 8 | Negative stock policy undefined. | Per-tenant setting, default: block the sale online; allow when syncing an offline sale that already happened, and flag it for review. |
| 9 | Offline conflict strategy undefined ("clear conflict strategy" was listed, not written). | Sales are append-only events, never merged. Master data uses version numbers. Section 8. |
| 10 | Backups at $0: Neon's free plan keeps only a short restore window. | Scheduled encrypted dump to free object storage, plus a monthly restore test. Section 13. |
| 11 | Country and currency not stated. You list GST, which suggests India. | Assumed India/INR/GST as the first configuration, but all tax rules are data, not code. Please confirm. |
| 12 | No password-reset or verification email provider. | Free-tier email service; Section 4. |
| 13 | No tenant lifecycle: suspend, export, delete. | Added to Phase 11 (data export and deletion on request). |
| 14 | No legal pages. | Terms of Service and Privacy Policy needed before the first paying client (India's DPDP Act applies to personal data of customers). Have a lawyer review. |
| 15 | "Check once again before developing UI" is a good instinct but has no gate. | Phase 2 ends with a schema review gate and the tenant-isolation test suite passing. |

## 3. Architecture and final tech stack

The app is a modular monolith: one Next.js project with strict internal modules (sales, inventory, auth and so on), one PostgreSQL database, no microservices. Every request passes the same chain: authenticate, resolve the tenant from the server-side session, check permission, run the business service inside one database transaction that has the tenant locked into Postgres itself.

&#91;embedded content: request path · 5 checkpoints\]

Each checkpoint assumes the one before it could be wrong, so even a bug in module code still meets the database's own isolation.

| Layer | Choice | Notes |
| --- | --- | --- |
| Framework | Next.js (App Router) + TypeScript in strict mode | Route handlers and server actions are thin; all rules live in `modules/*/service.ts`. |
| UI | Tailwind CSS + shadcn/ui + lucide-react | As in your notes. |
| Validation | Zod, shared by browser and server | The server re-validates everything; the browser check is only for convenience. |
| Forms | React Hook Form | As in your notes. |
| Database | PostgreSQL on Neon (free plan) | Portable: any Postgres host works later with no code change. |
| ORM and migrations | Drizzle ORM + drizzle-kit | SQL migrations committed to Git; RLS policies live in migrations. |
| DB driver | Pooled `pg` or Neon's WebSocket driver | Do not use Neon's HTTP driver for money flows: it cannot run multi-statement transactions. |
| Auth | A maintained library (Better Auth recommended, Auth.js as alternative) | Never hand-write sessions, tokens or crypto. Check the library's current docs when you reach Phase 3. |
| Password hashing | Argon2id | Fallback: scrypt from Node's built-in crypto if the host cannot run native modules. |
| Offline | Dexie (IndexedDB) + service worker via Serwist | Phase 9. |
| File storage | Cloudflare R2 | Logos, product images, encrypted backups. |
| Email | Free-tier transactional email (Resend or Brevo) | Verification and password reset only. |
| Rate limiting | A Postgres table at first | Avoids paying for Redis. Move to Redis only if measured need. |
| Unit and integration tests | Vitest, against a real Postgres | Not mocks: tenant isolation can only be proven against the real database. |
| End-to-end tests | Playwright | Login, sale, return, offline sale. |
| CI and security scans | GitHub Actions: type check, lint, tests, `npm audit`, gitleaks (secret scan), Semgrep OSS | Free for a small private repo within GitHub's monthly minutes. |
| Errors and uptime | Sentry free plan, UptimeRobot or similar free monitor | Check current free limits at signup. |

### Module boundaries

Separate modules, one folder each, with an `index.ts` as the only public door: `auth`, `tenants`, `catalog`, `inventory`, `purchasing`, `sales`, `returns`, `parties` (customers and suppliers), `expenses`, `tax`, `reports`, `audit`, `sync`. A module never reads another module's tables directly; it calls that module's service. This keeps the code reviewable by an AI agent in small pieces and lets any module be extracted later if ever needed.

## 4. Zero-cost plan, free-tier limits and upgrade triggers

Building and testing costs $0 end to end. The catch is the day you take real money from a client: two free plans stop fitting, and the plan below shows when and what it costs. Figures were checked on 1 Oct 2026 against the vendors' own pages; vendors change plans often, so re-check at launch.

### What the free plans really allow

| Service | Free allowance | What bites you |
| --- | --- | --- |
| [Neon Postgres, Free plan](https://neon.com/docs/introduction/plans) | 0.5 GB storage and 100 CU-hours of compute per project each month, 5 GB data transfer | Sleeps after 5 minutes idle and cannot be kept awake. Hitting the compute cap suspends the database until next month; hitting the storage cap makes writes fail. Restore window is only 6 hours, with 1 manual snapshot. Neon positions the plan for prototypes and small teams, not production. |
| [Vercel Hobby](https://vercel.com/docs/limits/fair-use-guidelines) | 100 GB transfer, 1M function calls, 4 hours active CPU per month | Restricted to non-commercial personal use. Vercel defines commercial use as any deployment tied to anyone's financial gain, including accepting payment for the site or its hosting. Use it only for private previews with fake data. |
| Cloudflare Workers free plan | 100,000 requests per day, 10 ms CPU per request | 10 ms CPU is very tight for server-rendered Next.js. Fine for static files. |
| GitHub (private repo) | Free repos, limited monthly CI minutes | Enough for a small team. |
| Cloudflare R2 | About 10 GB object storage on the free tier | Check the current figure at signup. Used for logos, images and encrypted backups. |

Rough sizing (my estimate, to be measured in Phase 6): an invoice with five lines, its payment, stock movements and audit rows takes a few kilobytes, so 0.5 GB holds on the order of 100,000 invoices across all tenants. The 100 CU-hours cover about 400 hours a month of the smallest database size, enough for a few small shops in one time zone.

### Cost by stage

| Stage | Setup | Monthly cost |
| --- | --- | --- |
| 0. Build and test (now) | Local development, GitHub, Neon Free, Vercel Hobby for private previews with fake data | $0 |
| 1. First paying client | Neon Launch (pay-as-you-go, no monthly minimum; Neon's own light-usage example is about $2.31) plus a host whose terms permit commercial use, such as Cloudflare Workers Paid ($5/month) or Vercel Pro ($20 per seat) | About $5 to $25 |
| 2. Several clients | Same, with scale-to-zero disabled on Launch so the first request is never slow | Grows with usage; keep a spending alert on |
| 3. Compliance or SLA demands | Neon Scale plan | Priced per use; only if a client requires it |

Before stage 1, also verify the terms of any free host you consider (Netlify, Render and others advertise commercial use on free plans, but I have not confirmed their current terms or limits). A $5 to $25 bill is one small client's monthly fee, so this plan treats the first client as the funding event.

### Upgrade triggers

| Trigger | Action |
| --- | --- |
| First client who pays | Move to stage 1 before invoicing them |
| Database above 400 MB (80% of the cap) | Upgrade Neon; writes fail at 0.5 GB |
| Compute above 80 CU-hours in a month | Upgrade Neon |
| You need restores older than 6 hours | Neon Launch (up to 7 days) |
| First-request delay annoys users after idle | Disable scale-to-zero on Launch |
| A client asks for SOC 2 or an uptime SLA | Neon Scale plan |

### Design rules that keep the free tier safe

- Show a friendly loading state: the first request after 5 idle minutes wakes the database and takes noticeably longer.
- Store images in R2, never in the database.
- Keep audit and sync logs lean and archive old rows (Phase 11), because storage is the first cap you will hit.

## 5. Multi-tenancy and security design

Security here means that a mistake by you, your AI agent or a cashier cannot expose one business's data to another. The design stacks independent layers so that any one of them failing is caught by the next.

### 5.1 Five layers of tenant isolation

1. **Identity.** The tenant comes only from the server-side session (the user's membership record). Request bodies, URLs, headers and cookies are never trusted for `tenant_id`. Schemas are strict, so a request that includes a `tenant_id` field is rejected.
2. **Code.** All database work goes through one function, `withTenant(ctx, fn)`, which opens a transaction and sets the tenant for it. Repository functions require a `TenantContext` argument in their TypeScript type, so code that forgets the tenant does not compile.
3. **Database (Row-Level Security).** Every tenant table has RLS switched on and forced, with a policy that only matches rows where `tenant_id` equals the transaction's tenant setting. The app connects as a restricted role (`app_user`) that does not own the tables and cannot bypass RLS. A separate `migrator` role runs migrations. On Neon, create these roles yourself in SQL; the default owner role must never be used by the running app.
4. **Relations.** Foreign keys include the tenant, for example `(tenant_id, product_id)` referencing `products(tenant_id, id)`, so an invoice line cannot point at another tenant's product even by accident.
5. **Proof.** An automated test suite creates Tenant A and Tenant B and tries to read, update, delete, export and list each other's data through every API route. A second check in CI fails the build if any table with a `tenant_id` column lacks RLS.

One technical rule is critical: set the tenant with a transaction-local setting (`set_config('app.tenant_id', value, true)`). A session-wide setting can leak between users when connections are pooled.

### 5.2 Authentication and sessions

- Passwords hashed with Argon2id; minimum 12 characters; reject passwords found in known breach lists (the free Pwned Passwords range API works without sending the password).
- Session cookie: HttpOnly, Secure, SameSite=Lax, random, stored server-side so it can be revoked. Rotate on login and on role change; idle timeout and absolute timeout.
- Email verification and password reset use single-use, short-lived tokens that are stored hashed.
- Login and reset endpoints are rate-limited per IP and per account, with growing delay after failures. Error messages never reveal whether an email exists.
- Device and session list with "log out everywhere"; deactivating a user kills all their sessions at once.
- Optional authenticator-app two-factor for Owner and Admin (Phase 11).
- CSRF: SameSite cookies plus an Origin-header check on every state-changing request.

### 5.3 Authorization (roles and permissions)

Every service function starts with `requirePermission(ctx, "...")`. The browser hides buttons for convenience only; the server decides. Default roles (editable per tenant later):

| Action | Owner | Admin | Manager | Cashier | Accountant |
| --- | --- | --- | --- | --- | --- |
| Create sale | Yes | Yes | Yes | Yes | No |
| Void a posted invoice | Yes | Yes | Yes | No | No |
| Give discount above a set limit | Yes | Yes | Yes | No | No |
| Change a selling price | Yes | Yes | Yes | No | No |
| Stock adjustment | Yes | Yes | Yes | No | No |
| Create purchase | Yes | Yes | Yes | No | No |
| View cost price and profit | Yes | Yes | Yes | No | Yes |
| Reports and exports | Yes | Yes | Yes | No | Yes |
| Manage users and roles | Yes | Yes | No | No | No |
| Business and tax settings | Yes | Yes | No | No | No |
| Delete business or transfer ownership | Yes | No | No | No | No |

### 5.4 Application hardening

- Zod validation with strict schemas on every input; outputs are shaped by explicit DTOs, never raw database rows.
- Parameterized queries only (the ORM does this); a lint rule bans raw SQL built from strings.
- No `dangerouslySetInnerHTML`; Content Security Policy with nonces; security headers (HSTS, frame-ancestors none, nosniff, Referrer-Policy, Permissions-Policy). CORS is same-origin only, no wildcard.
- Uploads: allow-list of PNG, JPEG and WebP, 2 MB limit, check magic bytes, re-encode server-side to strip metadata, random file names, tenant-prefixed private storage with short-lived signed links.
- IDs are random UUIDs, never sequential numbers.
- Secrets only in environment variables, validated at startup by one `env.ts` file; `.env*` ignored by Git; gitleaks runs before every commit and in CI; separate development and production secrets; rotate immediately if leaked.
- Users see a generic error with a reference code; stack traces and SQL go only to private logs. Logs never contain passwords, tokens or full card-like data.
- Dependencies: committed lockfile, Dependabot, `npm audit` in CI, few packages.

### 5.5 Audit trail

An `audit_logs` table records who (user, role, device), what, which record, before and after values, tenant, IP, request ID and time. The app role can insert but never update or delete (privileges revoked plus a database trigger that blocks changes). Audited events: logins and failures, user and role changes, price changes, invoice creation and void, payments, returns, stock adjustments, purchases, settings, exports, and all admin actions.

### 5.6 Threats and the control that stops each

| Threat | Controls |
| --- | --- |
| Tenant A reads Tenant B (IDOR/BOLA) | Layers 1 to 5 above; isolation test suite in CI |
| Attacker sends a forged `tenant_id` | Strict schemas reject it; tenant taken from session; RLS ignores the request |
| SQL injection | Parameterized queries only; lint ban on string-built SQL |
| Cross-site scripting | React escaping, no raw HTML, CSP with nonces |
| CSRF | SameSite cookies, Origin check |
| Password guessing or credential stuffing | Argon2id, rate limits, lockout delay, breached-password check |
| Stolen session | HttpOnly cookie, server-side revocation, rotation, session list |
| Cashier escalates privileges | Server-side permission checks; role changes audited |
| Double-click or replayed request charges twice | Idempotency keys with a unique database constraint |
| Malicious or vulnerable package | Lockfile, audit, Dependabot, secret and code scanning in CI |
| Leaked secret | gitleaks, separate environments, rotation procedure |
| Insider tampering with history | Append-only ledger and audit tables; posted invoices cannot be edited |
| Data loss | Encrypted scheduled backups, monthly restore test (Section 13) |

## 6. Database design

The design merges both of your entity lists and adds the tables your notes implied but never named. Review this section with an accountant or an experienced developer before Phase 2 ends; it is the hardest thing to change later.

### 6.1 Rules for every table

- Primary key `id` is a random UUID. Every tenant table has `tenant_id` (not null), `created_at`, `updated_at`, `created_by`, and a `version` number used for sync conflicts.
- Money is `bigint` in minor units (paise or cents). Quantities are `numeric(14,3)`. Rates are `numeric(7,4)`. Never floating point.
- Times are `timestamptz` in UTC; the business time zone is a tenant setting used only for display and day boundaries.
- Master data (products, customers) is soft-deleted (`archived_at`). Financial records are never deleted.
- Every index on a tenant table starts with `tenant_id`.

### 6.2 Tables

| Group | Tables | Notes |
| --- | --- | --- |
| Platform (no tenant column) | `tenants`, `plans`, `subscriptions`, `subscription_payments`, `users`, `sessions`, auth-library tables | `users` are global identities; `sessions` store the active tenant after a membership check. Subscription billing is separate from customer invoices. |
| Access | `memberships`, `roles`, `permissions`, `role_permissions`, `branches`, `devices` | A membership links user, tenant, role and branch scope. V1 screens support one tenant per user; the table allows more later. |
| Catalog | `categories`, `brands`, `units`, `products`, `product_variants`, `barcodes`, `serial_numbers` | Every product has at least one variant (a plain item has a single default variant). `serial_numbers` holds IMEI or serial per unit. |
| People | `customers`, `suppliers`, `party_ledger_entries` | Balances are never stored as a number you edit; they are the sum of append-only ledger entries. |
| Tax | `tax_rates` | Effective-dated, so a rate change never alters old invoices. HSN or SAC code is stored on the product. |
| Sales | `invoices`, `invoice_items`, `invoice_payments`, `invoice_sequences`, `returns`, `return_items`, `held_carts` | Invoice items store a snapshot of name, price, tax rate and cost at the time of sale. |
| Purchasing | `purchases`, `purchase_items`, `purchase_payments`, `purchase_returns` | Supplier payables come from `party_ledger_entries`. |
| Inventory | `stock_movements` (append-only ledger), `stock_balances` (fast cache) | The ledger is the source of truth; the balance row is updated in the same transaction and can always be rebuilt from the ledger. |
| Money out | `expense_categories`, `expenses` |  |
| System | `audit_logs` (append-only), `sync_operations`, `settings`, `files`, `rate_limits` | `sync_operations` stores each client operation ID and its result for idempotency. |

### 6.3 Constraints that protect the data

| Table | Constraint | Purpose |
| --- | --- | --- |
| `invoices` | Unique `(tenant_id, series, number)` | No duplicate invoice numbers |
| `invoices` | Check: total equals subtotal minus discount plus tax | Totals cannot be inconsistent |
| `invoices` | Trigger: a posted invoice cannot be updated except to void it | Immutability |
| `stock_movements` | Privileges and trigger block UPDATE and DELETE | Ledger cannot be rewritten; corrections are new reversing rows |
| `stock_movements` | Unique `(tenant_id, source_type, source_line_id, movement_type)` | A retried sale cannot post stock twice |
| `stock_balances` | Unique `(tenant_id, variant_id, branch_id)` | One balance per item per branch |
| `serial_numbers` | Unique `(tenant_id, serial)` and a status field (in stock, sold, returned, scrapped) | An IMEI can be sold only once until returned |
| `barcodes` | Unique `(tenant_id, code)` | A scan finds exactly one item |
| `sync_operations` | Unique `(tenant_id, device_id, client_op_id)` | Safe retry of offline operations |
| All child tables | Composite foreign key `(tenant_id, parent_id)` | No cross-tenant references |
| All tenant tables | RLS enabled and forced | Database-level isolation |

### 6.4 Clothing and mobile-shop modes

Both modes are configuration, not separate apps. A business picks a template when it is created, and the template switches on fields and screens.

- **Clothing:** variant attributes size, colour, brand and fabric; variant-level SKU, barcode, price and stock; exchange as a return plus a new sale in one action.
- **Mobile shop:** product attributes brand, model, RAM, storage and colour; the product is set to "track by serial", so each unit is a `serial_numbers` row and a sale must name the exact IMEI; warranty months on the product produce a warranty end date on the sale; accessories stay quantity-tracked.

Variant attributes are stored as JSON, but each template has a Zod schema that validates it, and fields used for search are indexed.

## 7. Money, tax, invoice numbering and transaction flows

These are the rules where a small mistake becomes a wrong invoice or a wrong stock count. Items marked **Accountant** need a person who knows the tax law of the business's country to confirm before launch.

### 7.1 Money and rounding

- All amounts are integers in minor units. 12.50 is stored as 1250.
- Tax is calculated per invoice line, then rounded to the nearest minor unit (half up). A tenant setting can switch to rounding per invoice. **Accountant:** choose the default.
- Tax-exclusive price: tax = round(net x rate). Tax-inclusive price: net = round(gross / (1 + rate)) and tax = gross - net, so lines always add up exactly.
- An optional round-off line brings the invoice total to the nearest whole unit and is shown separately.
- The same pure calculation function runs in the browser (for the cart) and on the server (the authority). Tests compare both with hundreds of cases.

### 7.2 Tax (GST, assumed India)

- Tax rates are rows in `tax_rates` with effective dates, never constants in code. Clothing rates can depend on the price per piece, so a rate row can carry a price range. **Accountant:** supply the current slabs; do not rely on memory or on this document.
- Same-state sales split tax into two equal parts (CGST and SGST); other-state sales carry a single IGST amount. The business state and the place of supply decide which. Store the split on each line.
- Business settings: GSTIN, registered state, registered or unregistered, composition scheme (no tax charged), and whether prices are tax-inclusive.
- Store the HSN or SAC code per product and print it where required. Large-turnover businesses may need e-invoicing; leave a clearly marked hook and do not build it until a client needs it.
- Anything uncertain is labelled "owner or accountant to validate" in the app settings screen and in the code comments.

### 7.3 Invoice numbering

- Each tenant has one or more series per financial year (for example INV-2026-27-000123). A counter row in `invoice_sequences` is incremented inside the sale transaction with a row lock, so numbers cannot repeat, and a rolled-back sale does not burn a number.
- Offline devices each get their own series prefix (for example INV-D2-...), so an offline sale has its final legal number at the moment it is made and cannot clash with another till. **Accountant:** confirm that several parallel series are acceptable.
- Posted invoices are never edited or deleted. A mistake is corrected by voiding (reason required, manager permission) or by a credit note, which has its own series.

### 7.4 Inventory rules

- Movement types: `PURCHASE_IN`, `SALE_OUT`, `SALE_RETURN_IN`, `PURCHASE_RETURN_OUT`, `ADJUSTMENT_IN`, `ADJUSTMENT_OUT`, `TRANSFER_IN`, `TRANSFER_OUT`, `OPENING_STOCK`, `VOID_REVERSAL`.
- Each movement stores signed quantity, unit cost, reason, reference (invoice, purchase, return) and the user.
- The service takes row locks on the affected balances in a fixed order (sorted by variant ID) to prevent deadlocks, and decreases stock with a conditional update that only succeeds if enough stock remains.
- Negative stock is a tenant setting. Default: blocked for online sales. An offline sale that already happened at the counter is accepted and flagged for review, never silently dropped.
- Cost method: start with weighted average cost, stored on each movement so profit reports stay stable.

### 7.5 The sale transaction

The whole sale is one database transaction. If any step fails, nothing is saved.

1. Authenticate, check the `sales.create` permission, validate the input, and look up the idempotency key. If it was already processed, return the stored result.
2. Begin the transaction and set the tenant.
3. Load products, prices and tax rates from the database. Client-supplied prices are ignored unless the user may override prices, and then the override is audited.
4. Check the discount against the user's limit.
5. Lock the stock balances in order and confirm availability; for serial-tracked items confirm each IMEI is in stock.
6. Calculate totals in integer arithmetic; confirm payments add up to the total (or record the rest as customer credit within the credit limit).
7. Take the next invoice number.
8. Insert the invoice, its items (with snapshots) and its payments.
9. Insert `SALE_OUT` movements, update balances, mark serials as sold and set warranty end dates.
10. Add a customer ledger entry if any amount is on credit.
11. Write the audit record.
12. Save the idempotency record with the response.
13. Commit. On any error, roll back and return a safe message.
14. After the commit only: produce the PDF or print view and send any notification. Failures here never undo the sale.

### 7.6 Other flows

| Flow | Steps in one transaction |
| --- | --- |
| Purchase | Check idempotency, validate supplier and lines, calculate totals, insert purchase and items, insert `PURCHASE_IN` movements, update balances and average cost, add supplier ledger entry, record any payment, audit, commit. |
| Return | Load the original invoice, check each returned quantity against what was sold minus earlier returns, check serials, insert return and items, insert `SALE_RETURN_IN` movements only for items marked resellable (damaged goods go to a scrap reason), record refund or credit note, reverse the customer ledger as needed, take the credit note number, audit, commit. |
| Adjustment | Require reason and permission, lock the balance, insert `ADJUSTMENT_IN` or `ADJUSTMENT_OUT` with a mandatory reason code, update the balance, audit, commit. Large adjustments can require a second approver (setting). |
| Void invoice | Require permission and reason, confirm no later return depends on it, insert reversing movements and payments, mark the invoice voided, reverse the ledger, audit, commit. The original rows stay unchanged. |
| Exchange (clothing) | A return and a new sale in one transaction, with the price difference as one payment or refund. |

## 8. Offline-first and sync design

The governing rule: saved on the device is not saved in the business. The server's database is the only authority, and every offline operation travels through a queue until the server confirms it. Offline is built in Phase 9, but the design rules below apply from the first sales endpoint in Phase 7, because retrofitting them is where offline projects fail.

### 8.1 Rules that apply from day one

- Records created at the counter (sales, returns, payments) get their UUID on the device, not on the server.
- Every write endpoint accepts a `client_op_id` and is idempotent: the same operation sent twice produces one result.
- The server recomputes prices, tax, totals and stock effects; it never trusts the client's numbers for money.

### 8.2 How an offline sale flows

1. The till validates the cart against cached products, prices and tax rates (each cached record carries a version).
2. In one local IndexedDB transaction it saves the sale and adds an entry to an `outbox` table: operation ID, device ID, type, payload, created time, status, attempts, last error.
3. The receipt prints with a visible "pending sync" badge and the device's own invoice series number.
4. When the connection returns, the sync engine sends outbox entries in creation order, so a return never arrives before its sale.
5. The server processes each operation in its own transaction, keyed by `(tenant, device, client_op_id)`. A repeat returns the stored result.
6. The device marks the entry synced only after the server confirms the commit. Network errors and server errors retry with exponential backoff and random jitter (1 s, 2 s, 4 s, up to 5 minutes). Validation errors do not retry; they move to a visible failed list.

### 8.3 Conflict strategy

| Data | Strategy |
| --- | --- |
| Sales, returns, payments, purchases | Append-only events, never merged. Accepted if valid. If stock is short at sync time, accept the sale (the goods already left) and flag negative stock for a manager. |
| Product and customer edits | Version check. On mismatch the server wins by default and the user sees both versions on a conflict screen. |
| Price changed while the till was offline | Keep the price the customer actually paid, record the server price beside it, flag the difference. |
| Same IMEI sold on two offline devices | First to sync wins; the second is flagged "needs resolution" for a manager. |
| Product archived while a till still sold it | Accept and flag. |
| Time differences | Server time is authoritative; device time is stored as information only. |

### 8.4 No silent data loss

- A Sync status area shows pending count, oldest pending age, and failed items with the exact reason, a retry button, and a way to export the item as a file.
- Logging out or clearing data with unsynced items shows a blocking warning.
- The app asks the browser for persistent storage; on browsers that may still evict data (notably some mobile Safari cases) it shows a warning to sync often.
- App updates never apply in the middle of a sale or while the outbox is processing.

### 8.5 Offline security

- IndexedDB is not encrypted, so cache only what the role needs (a cashier's device never holds cost prices or profit data) and never store passwords or long-lived secrets.
- Offline access is limited to a time window after the last online login (default 72 hours, a tenant setting).
- Devices are registered. If an owner revokes a device, the server rejects its next sync and the app wipes its local data after showing what was unsynced.
- Every synced operation is revalidated against the user's current role; a deactivated user's late operations are rejected and flagged.

### 8.6 Offline tests (Phase 9 gate)

Playwright tests with the network switched off and on: sell offline then sync; send the same operation twice; kill the browser during sync and resume; two tills selling the same IMEI; return queued before its sale; revoked device; expired offline window.

## 9. Project file structure

One repository, one Next.js project, business logic in modules. Pages and API routes stay thin; every rule lives in a module's `service.ts` where it can be tested without a browser.

```text
billing-saas/
  CLAUDE.md                  rules the AI agent must follow (Section 10)
  README.md
  .env.example               names of variables only, never values
  docs/
    decisions/               one short file per architecture decision
    business-rules.md        tax, rounding, numbering (accountant-approved)
    security-checklist.md
    runbook.md               backup, restore, incident steps
  drizzle/                   generated SQL migrations (committed to Git)
  scripts/
    db-roles.sql             creates app_user and migrator roles
    check-rls.ts             fails if a tenant table lacks RLS
    backup.sh  restore-test.sh
    seed-dev.ts              fake data for development only
  public/                    manifest, icons
  src/
    app/
      (public)/              login, register, reset-password, verify-email
      (app)/                 signed-in area with auth guard
        dashboard/ pos/ products/ inventory/ purchases/ sales/
        returns/ customers/ suppliers/ expenses/ reports/ settings/
      api/                   sync/, health/, auth/ route handlers
    modules/                 one folder per business area
      auth/ tenants/ catalog/ inventory/ purchasing/ sales/
      returns/ parties/ expenses/ tax/ reports/ audit/ sync/
        schema.ts            tables for this module
        service.ts           business rules, permission checks
        repo.ts              queries (require TenantContext)
        dto.ts               what the API may return
        index.ts             the only public door
        *.test.ts
    db/
      client.ts              pooled connection as app_user
      with-tenant.ts         withTenant(ctx, fn)
      schema/index.ts
    lib/
      env.ts                 validated environment variables
      money.ts               integer money and tax maths
      ids.ts errors.ts logger.ts rate-limit.ts security-headers.ts
    offline/                 dexie.ts, outbox.ts, sync-engine.ts (Phase 9)
    components/              ui/ (shadcn), pos/, forms/, tables/
    request guard file       auth check and security headers (named middleware or
                             proxy, depending on your Next.js version)
  tests/
    isolation/               Tenant A vs Tenant B attacks
    integration/             real Postgres
    e2e/                     Playwright
    security/                headers, rate limits, auth abuse
  .github/workflows/         ci.yml, security.yml, backup.yml
```

Dependency rules, enforced by a lint rule so they cannot be broken quietly:

- `app` and `api` may call `modules`; `modules` may call `db` and `lib`; nothing calls upward.
- A module may use another module only through that module's `index.ts`.
- Only `db/` may open a database connection; only `modules/*/repo.ts` may write queries.

## 10. Rules file for the AI coding agent

Save the text below as `CLAUDE.md` in the project root in Phase 1. The agent reads it at the start of every session, so it replaces the long master prompt in your notes and keeps every phase consistent.

```markdown
# CLAUDE.md - rules for this project

## Who you are working with
The owner is a non-developer product owner. You act as senior architect,
backend and frontend engineer, database engineer, security engineer, QA
and DevOps. The owner runs commands, tests business flows and decides
product questions.

## How to work
1. Work on ONE phase at a time, from the blueprint (or the owner's message).
   Start by stating the goal, the files you will create or change, and
   how we will know it works. Then build it.
2. Ask at most 3 questions at once, and only about rules that affect money,
   tax, stock, security or data integrity. For anything else choose the
   conventional option and say so in one line.
3. Give exact commands one step at a time, with the expected output and
   what to paste back if it fails. Use simple language; explain each
   important decision in 2-3 sentences.
4. Keep steps small: no more than about 10 files per step. Commit often
   with clear messages.
5. After every task run typecheck, lint and tests. Report the real results.
   Never say something passes unless you ran it. If something fails and
   you cannot fix it, say so plainly.
6. Never invent business rules silently. Unclear tax, rounding, numbering
   or accounting rules go into docs/business-rules.md as OPEN QUESTIONS
   for the owner and the accountant.

## Architecture (do not change without an ADR in docs/decisions)
- Next.js (App Router) + TypeScript strict, Tailwind, shadcn/ui.
- PostgreSQL, Drizzle ORM, SQL migrations committed to Git.
- Modular monolith. Modules talk only through their index.ts.
- Business rules live in modules/*/service.ts, never in pages or routes.
- No microservices, no Redis, no paid services without owner approval.

## Security rules (non-negotiable)
- tenant_id comes ONLY from the server session. Never from request data.
- Every tenant table: tenant_id not null, RLS enabled and forced, composite
  foreign keys. All DB access goes through withTenant(ctx, fn).
- The app connects as app_user (no BYPASSRLS, not table owner).
  Migrations use the separate migrator role.
- Validate every input with strict Zod schemas. Return explicit DTOs, never
  raw rows. Parameterized queries only; no string-built SQL.
- Every service function starts with requirePermission().
- Money is integer minor units. No floating point for money, ever.
- Posted invoices and ledger rows are never updated or deleted. Fix by
  voiding or reversing entries.
- Every money or stock write: one DB transaction, idempotency key,
  audit log entry.
- Secrets only in environment variables, validated in src/lib/env.ts.
  Never print, log, commit or hardcode a secret. Never ask the owner to
  paste a real secret into chat.
- No dangerouslySetInnerHTML. Safe error messages only; details to logs.
- Add a dependency only when needed; say why. Prefer well-maintained
  libraries over hand-written security code (auth, crypto, sessions).

## Testing rules
- Every module ships with tests. Money and tax maths need many cases.
- Every new tenant table must be covered by tests/isolation.
- Run scripts/check-rls.ts in CI.
- A feature is not done until its Definition of Done checklist is met.

## Definition of done (per feature)
Typecheck, lint and tests pass; isolation tests cover it; permission checks
and audit entries exist; inputs validated; errors handled; a short note in
docs; owner has tested the business flow by hand and signed off.

## Never do
- Never skip or weaken a test to make it pass.
- Never disable RLS, auth checks or validation "temporarily".
- Never run destructive commands (drop, truncate, force push) without
  asking and explaining.
- Never touch the production database from a development session.
```

## 11. Phase-by-phase plan with copy-paste prompts

The build is 13 phases (0 to 12). Each phase has what you do, a prompt to paste into your AI coding agent (Claude Code or similar), and a gate: a list of facts you must see true before moving on. Do not start the next phase while a gate is open.

Working routine for every phase:

1. Start a fresh agent session in the project folder, so it reads `CLAUDE.md` first.
2. Paste the phase prompt. Read the agent's plan before it builds.
3. Run the commands it gives you and paste back any error.
4. Test the business flow by hand as a shop owner would.
5. Check the gate. Commit to Git. Only then continue.

The agent should confirm current install commands and library versions from official documentation, since they change between releases.

### Phase 0: Decisions and accounts (no code)

**You do**

- Install Node.js (current LTS), Git, VS Code and Claude Code. Create a GitHub account and a private repository named `billing-saas`.
- Create a Neon account and two empty projects: `billing-dev` and `billing-test`. Do not create production yet.
- Write down answers to the open questions: country, currency, GST registration, financial-year start, first business type (clothing or mobile shop), languages, and whether sales may go negative on stock.
- Book 30 minutes with an accountant for the questions in Section 7.

**Prompt**

```text
Read the attached blueprint (sections 2, 7 and 8). Create docs/business-rules.md
with: (a) every rule already decided, and (b) a numbered OPEN QUESTIONS list
for the owner and the accountant covering rounding, tax slabs, invoice series,
credit notes, negative stock, cost method and financial year. Do not write any
code yet. Keep each question to one sentence with a suggested default.
```

**Done when:** every open question has an answer or an explicit "use the default", and the accountant has seen the list.

### Phase 1: Project setup and guardrails

**You do:** run the first command (the agent will confirm it is current), then paste the prompt.

```bash
npx create-next-app@latest billing-saas --typescript --tailwind --eslint --app --src-dir --use-npm
cd billing-saas
npx shadcn@latest init
```

**Prompt**

```text
Read CLAUDE.md (I will paste it as the first file) and docs/business-rules.md.
Phase 1: project setup and guardrails. Do the following in small steps:
1. Save CLAUDE.md. Create .env.example (names only) and make sure .env* files
   except .env.example are in .gitignore.
2. Install: zod, react-hook-form, lucide-react, drizzle-orm, pg, drizzle-kit,
   vitest, playwright, tsx. Explain each in one sentence.
3. Turn on TypeScript strict mode and the strictest sensible ESLint rules.
   Add lint rules that enforce the module boundaries in CLAUDE.md and ban
   dangerouslySetInnerHTML and string-built SQL.
4. Create src/lib/env.ts that validates environment variables with Zod and
   stops the app at startup if any are missing.
5. Add security headers (HSTS, nosniff, frame-ancestors none, Referrer-Policy,
   Permissions-Policy) and a nonce-based Content Security Policy.
6. Create /api/health returning only {status:"ok"}.
7. Set up GitHub Actions CI: install, typecheck, lint, tests, npm audit,
   and a gitleaks secret scan. Add a pre-commit gitleaks hook.
8. Create the folder structure from section 9 of the blueprint with empty
   index files only.
Give me the exact commands. Stop after each numbered step and wait for me.
```

**Done when:** CI is green on GitHub; the app runs locally; `git ls-files` shows no `.env` file except `.env.example`; a test commit containing a fake key is blocked by the secret scan.

### Phase 2: Database, roles, row-level security, isolation tests

**You do:** put the Neon connection strings in `.env.local` yourself (never paste real connection strings into chat), and run the role-creation SQL the agent gives you in Neon's SQL editor.

**Prompt**

```text
Phase 2: database foundation. Read CLAUDE.md and blueprint sections 5 and 6.
1. Write scripts/db-roles.sql creating two roles: migrator (owns tables, runs
   migrations) and app_user (no table ownership, NOBYPASSRLS, only needed
   privileges). Explain how to run it on Neon.
2. Configure Drizzle with migrations. Create FOUNDATION tables only: tenants,
   users, memberships, roles, permissions, role_permissions, branches,
   devices, settings, audit_logs, sync_operations, rate_limits.
3. Write the RLS helper: for every tenant table enable AND force RLS and add
   a policy matching tenant_id to current_setting('app.tenant_id'). Include
   composite foreign keys (tenant_id, id).
4. Write src/db/with-tenant.ts: withTenant(ctx, fn) opens a transaction and
   runs set_config('app.tenant_id', value, true) (transaction-local).
   Repositories must require a TenantContext type.
5. Make audit_logs append-only: revoke UPDATE and DELETE from app_user and
   add a blocking trigger.
6. Write scripts/check-rls.ts that fails if any table with tenant_id lacks
   forced RLS, and run it in CI.
7. Build tests/isolation: create Tenant A and Tenant B and prove each cannot
   read, update, delete or count the other's rows, even with a forged tenant
   id, and that a query WITHOUT withTenant returns zero rows.
8. Write docs/schema.md describing EVERY table planned in blueprint section 6
   (not yet created) so I can review the whole design before any UI.
```

**Done when**

- Isolation tests and `check-rls` pass locally and in CI.
- You connected as `app_user` in the Neon SQL editor, ran a select on a tenant table without a tenant set, and saw zero rows.
- You and an experienced reviewer read `docs/schema.md` and agreed or listed changes. This is your "check once again before UI" gate.

### Phase 3: Authentication, sessions and permissions

**You do:** create a free email-sending account (Resend or Brevo) and put its key in `.env.local`. Test with two real email addresses.

**Prompt**

```text
Phase 3: authentication and authorization. Read CLAUDE.md and blueprint
section 5.2 and 5.3.
1. Check the CURRENT documentation of Better Auth and Auth.js, recommend one
   in 5 lines, and wait for my choice. Do not hand-write session, token or
   crypto code.
2. Implement: register (creates the tenant, the owner membership and default
   roles in ONE transaction), login, logout, email verification, password
   reset, session list and "log out everywhere".
3. Passwords: Argon2id, minimum 12 characters, breached-password check.
4. Cookies: HttpOnly, Secure, SameSite=Lax; sessions stored server-side with
   rotation on login and role change, idle and absolute timeouts.
5. Rate limiting for login, register and reset, per IP and per account, using
   the rate_limits table. Same error message whether or not an email exists.
6. Seed the permissions and the role matrix from blueprint section 5.3.
   Write requirePermission(ctx, key) and use it in every service function.
7. Origin-header check for every state-changing request.
8. Tests: wrong-password flood is throttled; user enumeration is impossible;
   a revoked session stops working immediately; a cashier cannot call an
   owner-only route; a user of Tenant A cannot use Tenant B's session or ids.
```

**Done when:** all tests pass; you can register, verify, log in on two devices, revoke one, and see it logged out at once; a cashier account gets "not allowed" on owner pages and on the matching API calls (test with the browser's network tab).

### Phase 4: Business setup and settings

**Prompt**

```text
Phase 4: business setup. Read CLAUDE.md and blueprint sections 6 and 7.
Build screens and services for: business profile, logo upload (validated PNG,
JPEG or WebP, 2 MB, re-encoded, private storage in Cloudflare R2 with signed
links), address, currency, time zone, financial-year start, GST settings
(GSTIN, state, registered or composition, tax-inclusive pricing), invoice
series and prefixes, branches, a business template choice (clothing or mobile
shop) that switches on the matching fields, and user management (invite by
email, change role, deactivate). Every settings change writes an audit entry.
Only Owner and Admin may change settings. Mark any tax setting whose legal
effect is uncertain with "owner or accountant to validate". Create plans and subscriptions tables with an entitlement helper that
enforces branch, user and device limits from the plan row (no payment
integration yet). Add tests for permissions, validation, plan limits and
audit entries.
```

**Done when:** a new tenant can be fully configured through the screens; a deactivated user cannot log in; every change appears in the audit table; the upload rejects a renamed `.exe` and an oversized file.

### Phase 5: Catalog

**Prompt**

```text
Phase 5: catalog. Read CLAUDE.md and blueprint section 6.
Create (migrations, services, screens, tests): categories, brands, units,
products, product_variants (every product has at least one variant),
barcodes (unique per tenant), and serial_numbers with a "track by serial"
product flag. Include SKU, cost price, selling price, tax rate reference, HSN
code, reorder level, active flag and images (stored in R2).
Clothing template: size, colour, brand, fabric at variant level.
Mobile template: brand, model, RAM, storage, colour, warranty months.
Validate template attributes with a Zod schema per template.
Add fast search by name, SKU and barcode (indexed, paginated), and a CSV
import that validates every row and reports errors without importing
anything when any row fails. Price changes must be audited. Cashiers must not
see cost price. Add isolation tests for every new table.
```

**Done when:** you can create a product with variants, scan or type a barcode and find exactly one item, import a 500-row CSV, see a failed import change nothing, and confirm a cashier never sees cost price.

### Phase 6: Inventory ledger, suppliers and purchases

**Prompt**

```text
Phase 6: inventory and purchasing. Read CLAUDE.md and blueprint sections 6, 7.4
and 7.6.
1. Create stock_movements (append-only, UPDATE and DELETE blocked) and
   stock_balances. One service function, postMovement(), is the ONLY way stock
   changes. It locks balances in sorted order and decreases with a conditional
   update that only succeeds when enough stock remains (respecting the tenant's
   negative-stock setting).
2. Opening stock and stock adjustments with mandatory reason codes and
   permission checks. Serial-tracked items move one unit at a time.
3. Suppliers, purchases, purchase items, supplier payments and
   party_ledger_entries (balances are sums, never edited numbers).
   A purchase is ONE transaction with an idempotency key and an audit entry.
4. A script that rebuilds stock_balances from the ledger and reports any
   difference.
5. Tests: 100 parallel sales of the last unit never oversell; a retried
   purchase posts stock once; a failure injected halfway rolls back everything;
   Tenant B cannot touch Tenant A stock.
6. Insert 10,000 fake invoices-worth of movements in the dev database and
   report the database size so we can estimate free-tier capacity.
```

**Done when:** the concurrency test passes ten runs in a row; the rebuild script reports zero differences; you can enter a purchase on screen and see stock and the supplier balance change by the right amounts; the sizing number is written into `docs/decisions`.

### Phase 7: Billing and POS

**Prompt**

```text
Phase 7: billing and POS. Read CLAUDE.md, docs/business-rules.md and blueprint
section 7. Work in this order and stop after each step:
1. src/lib/money.ts: integer money and tax functions (tax-exclusive,
   tax-inclusive, CGST/SGST/IGST split, per-line rounding, round-off). Write at
   least 200 test cases including property-based tests (line totals always add
   up to the invoice total; never off by one unit).
2. tax_rates (effective-dated) and invoice_sequences with the row-lock counter.
3. The sale transaction exactly as in section 7.5, as ONE function with an
   idempotency key. Server recomputes all prices and totals.
4. Payments: cash, card, UPI, split payments, credit sale within the
   customer's limit.
5. POS screen: fast search, barcode input (USB scanners type like a keyboard),
   cart, quantity, discount with permission limit, customer selection,
   hold and resume cart, keyboard-friendly.
6. Invoice view: print and PDF with business details, tax split, HSN, and a
   QR or reference if the business setting requires it.
7. Void invoice (reason, permission, reversing entries).
8. Tests: rollback on injected failure at each of the 14 steps; double-click
   submit creates one invoice; two tills selling the last unit; discount over
   limit rejected; price tampering ignored; invoice numbers have no gaps
   after rolled-back sales; Tenant B cannot read or void Tenant A invoices.
```

**Done when:** you complete 50 varied test sales by hand (cash, split, credit, discount, tax-inclusive) and an accountant checks five of the printed invoices against a calculator; all tests pass ten times in a row; stock matches after every sale.

### Phase 8: Returns, customers, suppliers, expenses

**Prompt**

```text
Phase 8: returns and parties. Read CLAUDE.md and blueprint sections 7.5 and 7.6.
Build: customers and suppliers (profile, contacts, search, purchase history,
outstanding balance from party_ledger_entries), returns against an existing
sale (quantity check against earlier returns, serial check, resellable or
scrap, refund or credit note with its own number series), purchase returns,
exchange (return plus new sale in one transaction), customer payments against
balances, expense categories and expenses. Every flow is one transaction with
an idempotency key and an audit entry. Tests: returning more than sold is
rejected; returning twice is rejected; a credit note reverses the ledger
exactly; exchange rolls back as a whole; isolation tests for all new tables.
```

**Done when:** returns, exchanges and customer payments leave stock and balances correct in 20 manual scenarios you write down beforehand; the rebuild script still reports zero differences.

### Phase 9: Dashboard and reports

**Prompt**

```text
Phase 9: dashboard and reports. Read CLAUDE.md.
Build: dashboard (today's sales, payments by method, low stock, receivables,
payables), reports with date filters in the tenant's time zone: sales by
day, product, category and user; stock valuation; low stock; profit (permission
required); receivables and payables ageing; tax summary (labelled "validate
with accountant"); audit log viewer (Owner and Admin). CSV export is permission
checked, rate limited and audited. Use database aggregation with indexes, no
loading everything into memory. Tests: report totals equal the sum of invoices
for fixed fixtures; day boundaries are correct in two time zones; cashiers see
no profit or cost; exports are tenant-scoped. Measure report speed with
50,000 invoices and report the result.
```

**Done when:** a report total matches a hand calculation for a chosen day; reports with 50,000 invoices load in a few seconds (note the number); a cashier cannot reach profit pages or exports by URL.

### Phase 10: Offline PWA and sync

**Prompt**

```text
Phase 10: offline-first. Read CLAUDE.md and blueprint section 8 completely.
1. Make the app an installable PWA (manifest, service worker for the app
   shell via Serwist or the current recommended tool; check its docs first).
   App updates must never apply during a sale or while the outbox runs.
2. Dexie database: cached products, variants, barcodes, prices, tax rates,
   customers (only data the user's role may see), plus an outbox table.
3. Device registration and a per-device invoice series prefix.
4. Offline sale and offline return: validate locally, save sale and outbox
   entry in ONE Dexie transaction, print with a "pending sync" badge.
5. Sync engine: ordered sending, exponential backoff with jitter, retry only
   on network and server errors, validation errors go to a failed list.
6. Server endpoint /api/sync/operations: each operation in its own
   transaction, idempotent on (tenant, device, client_op_id), full
   revalidation of prices, stock and the user's CURRENT permissions.
7. Conflict rules exactly as in section 8.3, with a manager screen for
   flagged items. A Sync status area with pending count, oldest age, failures
   with reasons, retry and export.
8. Logout warning when unsynced items exist; 72-hour offline window setting;
   device revoke wipes local data after showing unsynced items.
9. Playwright tests with the network off and on for every case in 8.6.
```

**Done when:** you sell 30 items with Wi-Fi switched off, switch it on, and all 30 arrive once with correct stock; sending the same operation twice creates one invoice; closing the browser mid-sync loses nothing; two tills selling one IMEI produce exactly one flagged conflict.

### Phase 11: Security hardening and operations

**Prompt**

```text
Phase 11: hardening and operations. Read CLAUDE.md and blueprint sections 5
and 13.
1. Security review: go through the OWASP ASVS level 1 checklist and the
   OWASP Top 10 against this codebase. Write docs/security-review.md listing
   each item as pass, fail or not applicable, with the file or test that
   proves it. Fix every fail.
2. Run Semgrep, npm audit and gitleaks over the whole repo and history.
3. Authenticator-app two-factor for Owner and Admin.
4. Tighten the Content Security Policy; verify headers with a scanner.
5. Backups: a GitHub Actions workflow that runs pg_dump on a schedule,
   encrypts the file, uploads it to private R2 storage, keeps 30 daily and 12
   monthly copies. Write scripts/restore-test.sh that restores the latest
   backup into an empty database and runs sanity queries.
6. Error monitoring (Sentry free plan) that scrubs personal data, and an
   uptime check on /api/health.
7. Tenant data export (Owner only, audited) and tenant deletion on request
   with a grace period.
8. Archive or compact old sync_operations and rate_limits rows to protect
   free-tier storage.
9. A light load test (k6 or similar) of login, product search and sale
   creation; report results.
10. Draft Terms of Service and Privacy Policy pages for a lawyer to review.
```

**Done when:** `docs/security-review.md` has no open fails; a restore into an empty database succeeds and you verify real invoice totals in it; an alert reaches you when you deliberately break `/api/health`; a deliberate secret commit is blocked; headers score well on an external scanner.

### Phase 12: Pilot and launch

**You do**

- Create the production Neon project and a staging copy. Use separate secrets for each.
- Run a pilot with one friendly shop for at least two weeks alongside their normal process. Each evening compare the app's totals and stock with the shop's own record and write down every difference.
- Fix every difference before charging anyone. Then move to stage 1 hosting (Section 4) and onboard the first paying client.

**Prompt**

```text
Phase 12: launch. Read CLAUDE.md and blueprint sections 4, 13 and 14.
Prepare staging and production configuration with separate secrets and
databases. Write docs/runbook.md covering: deploy, roll back, restore from
backup, rotate a leaked secret, suspend a tenant, handle a data request, and
who to call. Add a pre-deploy checklist script that fails when tests, RLS
check, audit or secret scan fail. Create a read-only daily reconciliation
report (invoice totals vs payments vs stock movements per tenant) that
flags any mismatch. Create the onboarding checklist for a new client.
```

**Done when:** two weeks of pilot days reconcile to zero unexplained differences; the restore drill has been run in the last 30 days; the runbook has been followed once by you without help; the lawyer has reviewed the legal pages.

## 12. Quality gates and Definition of Done

This section is how "no bugs" is pursued in practice: defects are hunted by machines on every change, and the ones that matter most (money, stock, tenant leaks) have dedicated tests.

### 12.1 Definition of Done for every feature

- [ ] Typecheck, lint and all tests pass locally and in CI.
- [ ] Inputs validated with strict Zod schemas; outputs shaped by DTOs.
- [ ] `requirePermission` is called; the permission is in the role matrix.
- [ ] Money or stock writes are one transaction with an idempotency key.
- [ ] An audit entry is written for every sensitive action.
- [ ] New tenant tables have RLS and are covered by the isolation tests.
- [ ] Error cases handled with safe messages; no stack traces to users.
- [ ] Loading, empty and error states exist on screen.
- [ ] The owner tested the business flow by hand and signed off.
- [ ] A short note exists in `docs` and any new decision is recorded.

### 12.2 Test layers

| Layer | Tool | What it proves | Runs |
| --- | --- | --- | --- |
| Unit | Vitest | Money, tax and rounding maths; validators | Every commit |
| Integration | Vitest on a real Postgres | Transactions, constraints, concurrency, rollback | Every commit |
| Tenant isolation | Vitest, Tenant A vs B | No cross-tenant read, write, delete, export or count | Every commit |
| End to end | Playwright | Login, sale, return, offline sale, permissions in a real browser | Every pull request |
| Security | Semgrep, npm audit, gitleaks, header checks, auth-abuse tests | Known weakness patterns and leaked secrets | Every commit and weekly |
| Reconciliation | Daily script | Invoices vs payments vs stock movements agree per tenant | Daily in production |
| Restore drill | `restore-test.sh` | Backups really restore | Monthly |

### 12.3 Release gate

A deploy is blocked unless all of these pass: typecheck, lint, unit and integration tests, isolation tests, the RLS check, dependency audit, secret scan, and a Playwright smoke test of login and one sale on the staging copy.

### 12.4 Bug policy

- Anything that touches money, stock, authentication or tenant isolation is top priority: stop feature work.
- Every bug gets a failing test first, then the fix, so it can never return.
- Never weaken a test to make it pass; if a test seems wrong, raise it as a question.
- Keep a plain bug list in `docs/bugs.md` with date, impact and the test that now covers it.

## 13. Backups, monitoring and deployment

The free database plan only restores the last 6 hours of changes, so your own backups are the real safety net from day one.

### 13.1 Environments

| Environment | Database | Data | Secrets |
| --- | --- | --- | --- |
| Local | Neon project `billing-dev` | Fake seed data | `.env.local`, never committed |
| CI test | Neon project `billing-test` or a throwaway Postgres in the CI job | Created and destroyed by tests | GitHub Actions secrets |
| Staging | Copy of production structure | Fake or anonymized | Own set |
| Production | Neon production project | Real client data | Own set, different from all others |

Never point a development session at production. Staging and production are created at stage 1 (Section 4).

### 13.2 Backup layers

1. **Short-term undo:** Neon's history window (6 hours on Free, up to 7 days on Launch) for "I just broke something".
2. **Nightly encrypted dump:** a scheduled GitHub Actions job runs `pg_dump`, encrypts the file with a public key (age or GPG), and uploads it to a private R2 bucket. Keep 30 daily and 12 monthly copies.
3. **Monthly restore drill:** restore the newest dump into an empty database and compare row counts and a few invoice totals with production.

Three details that decide whether backups work:

- Row-level security hides other tenants' rows from a normal connection. The backup job needs a dedicated role that can read every row (check what Neon permits), and the restore drill must prove the dump contains all tenants.
- Keep the private decryption key offline in two places (password manager and a printed copy). Without it the backups are unreadable; never store it in the repository or in GitHub.
- The `pg_dump` client version must match the database's major version.

### 13.3 Monitoring and alerts

- Uptime monitor on `/api/health`, and Sentry for errors with personal data scrubbed.
- Structured logs with a request ID on every line; never log secrets or full personal data.
- Alerts to your phone for: more than a few 5xx errors in 10 minutes, a spike in failed logins, failed sync operations, a reconciliation mismatch, database storage above 80% of the plan, compute hours above 80% of the plan, a failed backup job.

### 13.4 Deployment routine

1. Work on a branch; open a pull request; CI must pass (Section 12.3).
2. Merge into `main` (protected: no direct pushes). A preview deployment with fake data is available for review.
3. Deploy to staging; run the smoke test.
4. Before a risky database change, take a manual Neon snapshot.
5. Run migrations as the `migrator` role. Migrations only move forward and stay compatible with the previous app version for one release (add first, switch code, remove later), so a code rollback never breaks the database.
6. Deploy to production. Rollback means redeploying the previous version; database mistakes are fixed forward or restored.

### 13.5 Domain, HTTPS and incidents

- Use a custom domain with free DNS and automatic HTTPS; redirect all HTTP to HTTPS.
- Keep a one-page incident procedure in `docs/runbook.md`: who decides, how to suspend a tenant, how to rotate secrets, how to inform affected clients.
- Ask the lawyer which breach-notification duties and deadlines apply to you and your clients' customer data before the first paying client.

## 14. Pricing plans and first-client checklist

Plans are data (`plans` and `subscriptions` tables), so changing a price or a limit never needs new code. Build the entitlement checks in Phase 4 and keep manual billing until you have a handful of clients.

### 14.1 Suggested plan structure

The limits below are a starting shape, not market-tested prices. Set the prices after talking to at least three prospective shop owners about what they pay now and what a mistake costs them.

|  | Starter | Standard | Pro |
| --- | --- | --- | --- |
| Branches | 1 | 2 | 5 or more |
| Users | 2 | 5 | 15 or more |
| Offline POS devices | 1 | 3 | 10 or more |
| Clothing or mobile module | One | One | Both |
| Reports and CSV export | Basic | Full | Full |
| Support | Email | Email, faster reply | Priority |
| Price | Set after interviews | Set after interviews | Set after interviews |

Pricing method: charge per business with limits on branches and users (shop owners understand this), offer a yearly discount, and keep the first month cheap or free for the first three clients in exchange for feedback.

### 14.2 Subscription states

1. **Trial:** limited days, real features, limited invoices.
2. **Active:** paid.
3. **Past due:** grace period with a banner.
4. **Suspended:** the app becomes read-only and export stays available. Never lock a shop out of its own records.
5. **Cancelled:** a fixed export window, then deletion on schedule (confirm the period with your lawyer).

### 14.3 How to collect money cheaply

Start with manual invoicing by bank transfer or UPI and a monthly reminder. This costs nothing and needs no payment-gateway integration. Add automated recurring billing through a payment provider once you have around five to ten clients and the manual work becomes a burden.

### 14.4 First-client checklist

- [ ] Phases 0 to 12 gates are closed, including two clean pilot weeks.
- [ ] Stage 1 hosting and the paid database plan are live, with a spending alert.
- [ ] Production backups ran for seven nights and one restore drill succeeded.
- [ ] Terms of Service and Privacy Policy reviewed by a lawyer and linked at signup.
- [ ] The client's products, opening stock and tax details are loaded and checked by the client.
- [ ] Staff trained on the till for one hour; a one-page cheat sheet printed.
- [ ] A support channel and response times are agreed in writing.
- [ ] A plan for the first week: you check the daily reconciliation report each evening.
- [ ] The client knows how to export their data.

## 15. Risks and honest limits

This plan lowers risk a lot but cannot remove it. Read this section before committing time and before promising anything to a client.

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| "No bugs" is not achievable | Every real system has defects; money and stock bugs cost clients real money | Gates, isolation tests, reconciliation report, a two-week pilot, and a bug policy that puts money, stock and tenant leaks first |
| A non-developer cannot judge AI-written security code by reading it | Subtle flaws look fine | Use maintained libraries for auth; rely on RLS and tests, not on trust; pay a freelance engineer for a few hours of review at the end of Phase 2 and again in Phase 11. This is the one place where $0 is unwise. |
| Wrong tax or invoice numbering | Legal and client-trust problem | Accountant signs off `docs/business-rules.md`; tax is data; clearly labelled "validate" settings |
| Free-tier limits | Database sleeps when idle; hard stops at the storage and compute caps; short restore window | Section 4 triggers, nightly backups, friendly loading states, upgrade at the first paying client |
| Hosting terms | Vercel Hobby forbids commercial use | Treat free hosting as development only; move to a commercial-permitted host before billing anyone |
| Scope is large | Thirteen phases is months of part-time work; scope creep is the usual killer | Launch with one business template (clothing or mobile), not both; keep the other for after the first client |
| AI agent drift | Long sessions forget rules and produce inconsistent code | `CLAUDE.md`, one phase per session, small steps, tests as the referee, review each diff summary |
| Offline complexity | Sync bugs lose or duplicate sales | Built last, on a stable core, with the full test list in 8.6 and idempotency from day one |
| Single point of failure (you) | If you are unavailable, a client's till has no support | Runbook, written support hours, backups you can restore, a named backup contact |
| Legal and privacy | Customer personal data; breach duties; data deletion requests | Lawyer reviews terms, privacy policy and breach procedure before the first paying client |
| Vendor change | Free plans and prices change often | Standard Postgres and portable code; re-check Section 4 every quarter |

### Not verified in this document

These came from vendor summaries or general knowledge and must be re-checked when you reach them: Cloudflare Workers Paid pricing and R2's free allowance, the commercial-use terms of other free hosts, the free limits of the email and error-monitoring services, and which authentication library is best maintained when you reach Phase 3. Tax rates, slabs and invoice rules are intentionally not stated here; they come from your accountant.

### Sources

- [Neon plans and limits](https://neon.com/docs/introduction/plans), checked 1 Oct 2026: Free plan storage, compute, scale-to-zero, restore window, exceed-limit behaviour, Launch example costs.
- [Vercel fair use guidelines](https://vercel.com/docs/limits/fair-use-guidelines), checked 1 Oct 2026: Hobby is non-commercial only, definition of commercial use, Hobby usage allowances.
- Supabase and Cloudflare free-tier details were read from vendor-summary articles and are not relied on for any decision above.
