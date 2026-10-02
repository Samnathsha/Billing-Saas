# Database schema: every table, built and planned

**Purpose.** This is the review gate before any screen is built (Phase 2,
"check once again before UI"). It describes every table from blueprint
section 6: the 12 that exist now and the ones later phases will add. Please
read it with an experienced developer (structure and security) and the
accountant (sales, tax, purchases, stock, ledgers), then either agree or
list changes. Changing a table is cheap now and expensive once real invoices
exist.

**How to review.** Each table has a one-line purpose, its key columns, the
rules the database itself enforces, and who can change it. The questions
that need a decision are collected in [Review questions](#review-questions)
at the end.

Status: **Built** = exists in the dev and test databases (Phase 2).
**Planned (Phase N)** = designed here, created in that phase.

---

## Rules every table follows

These come from blueprint 6.1 and CLAUDE.md, and most are checked
automatically (`scripts/check-rls.ts`, `tests/isolation`).

| Rule | Detail |
|---|---|
| IDs | Random UUIDs, never sequential numbers. Sales, returns and payments get their UUID on the till (offline-ready). |
| Business separation | Every business table has `tenant_id` (never empty). Row-level security is **enabled and forced** on **every** table; the app sees only the current business's rows. Foreign keys between business tables include `tenant_id`, e.g. `(tenant_id, product_id)` → `products(tenant_id, id)`, so no row can point at another business. |
| Standard columns | `created_at`, `updated_at`, `created_by`, `version` (sync conflict check). Append-only tables have `created_at` only. |
| Money | `bigint` in **paise** (₹12.50 is stored as 1250). Never floating point. |
| Quantities, rates | Quantities `numeric(14,3)`; tax rates `numeric(7,4)`; percentages as integer basis points (500 = 5.00%). |
| Time | `timestamptz`, stored in UTC; the business time zone is a setting for display and day boundaries. Server time is authoritative; device time is kept as information only. |
| Deleting | Master data (products, customers...) is **archived** (`archived_at`), never deleted. Financial records are **never** updated or deleted; mistakes are fixed by voiding or reversing entries. |
| Append-only | Ledgers and posted documents use `app_make_append_only`: no UPDATE, DELETE or TRUNCATE for any role, and `created_at` is stamped by the database clock. |
| Indexes | Start with `tenant_id`. One reviewed exception: `memberships(user_id)` for login. |
| Access | The app connects as `app_user`, which owns nothing and cannot bypass RLS. Each table grants only the operations it needs (most have no DELETE). |

### Deliberate exceptions (already built)

- `created_by` has no foreign key to `users` (it would tie every module's
  tables to `users`); `audit_logs` is the authoritative record of who did
  what.
- `memberships_user_idx` does not start with `tenant_id`: login must find a
  user's businesses before a business is chosen.

---

## How the tables fit together

```text
tenants ─┬─ settings (1 per business)
         ├─ branches ─┬─ devices ── sync_operations
         │            └─ stock_balances (per variant per branch)
         ├─ roles ── role_permissions ── permissions (global list)
         ├─ memberships ── users (global identities) ── sessions
         ├─ categories / brands / units ── products ── product_variants ─┬─ barcodes
         │                                                              └─ serial_numbers (IMEI)
         ├─ customers ─┐                                   tax_rates (global, effective-dated)
         ├─ suppliers ─┴─ party_ledger_entries (append-only; balances = sum)
         ├─ invoices ─┬─ invoice_items ── stock_movements (append-only ledger)
         │            ├─ invoice_payments
         │            └─ returns ── return_items
         ├─ purchases ─┬─ purchase_items
         │             ├─ purchase_payments
         │             └─ purchase_returns ── purchase_return_items
         ├─ expense_categories ── expenses
         ├─ invoice_sequences, held_carts, files
         └─ audit_logs (append-only), subscriptions ── subscription_payments
plans (global)   rate_limits (global, no business data)
```

---

## 1. Platform and access

### tenants: Built (Phase 2)
A business using the app. Its `id` is the tenant id.
- Columns: `name` (1–200 chars), `template` (`clothing` | `mobile`),
  `status` (`active` | `suspended` | `closed`).
- Access: a business sees only itself. Before a business is chosen (login),
  a user also sees, read-only, the businesses they are an active member of.
  A business can only be created "as itself" (its new id set as the current
  tenant). No DELETE: a business is closed, not deleted.

### users: Built (Phase 2; login fields in Phase 3)
A person who can log in. Global: one person may belong to several
businesses (V1 screens: one).
- Columns: `email` (unique ignoring case), `display_name`,
  `email_verified_at`, `status` (`active` | `disabled`).
- Access: yourself plus people in the current business; only your own
  account can be changed. Login by email and staff invitations are designed
  in Phase 3 (they need a narrow, reviewed path, since the user is not known
  yet).
- Phase 3 decides with the auth library: password hash (Argon2id), and
  whether login data lives here or in the library's own tables.

### sessions: Planned (Phase 3)
A signed-in browser or till.
- Columns: `token_hash` (the cookie value is never stored, only its hash),
  `user_id`, `tenant_id` (the active business, set only after a membership
  check), `device_id`, `created_at`, `last_seen_at`, `idle_expires_at`,
  `absolute_expires_at`, `revoked_at`, `ip`, `user_agent`.
- Rules: rotated on login and role change; "log out everywhere" and
  deactivating a user revoke all sessions at once.
- Email-verification and password-reset tokens: single-use, short-lived,
  stored hashed (table names follow the Phase 3 auth library).

### plans: Planned (Phase 12)
Subscription plans you sell. Global, read-only for the app.
- Columns: `code`, `name`, `price_paise_per_month`, limits (`max_branches`,
  `max_devices`, `max_users`).

### subscriptions: Planned (Phase 12)
Which plan a business is on. Kept apart from the business's own invoices.
- Columns: `tenant_id`, `plan_code`, `status` (`trialing` | `active` |
  `past_due` | `cancelled`), `current_period_start`, `current_period_end`.
- Access: a business can read its own; changes come from the platform's
  billing process, not from shop staff.

### subscription_payments: Planned (Phase 12)
Money a business pays you. Append-only.
- Columns: `tenant_id`, `subscription_id`, `amount_paise`, `paid_at`,
  `method`, `reference`.

### memberships: Built (Phase 2)
Links a user to a business with one role, optionally limited to one branch.
- Columns: `user_id`, `role_id`, `branch_id` (empty = all branches),
  `status` (`active` | `disabled`).
- Rules: one membership per user per business; role and branch must belong
  to the same business. No DELETE (disable instead). Before a business is
  chosen, a user can read their own memberships (login only).

### roles: Built (Phase 2)
A business's roles. Defaults on creation (Phase 3): Owner, Admin, Manager,
Cashier, Accountant, with the permissions in blueprint table 5.3.
- Columns: `name` (unique per business, ignoring case), `is_system`
  (default roles cannot be renamed or deleted: service rule).

### permissions: Built (Phase 2)
The fixed list of actions a role can be allowed. Global, read-only for the
app; only migrations add rows. Current list: `sales.create`,
`invoices.void`, `discounts.above_limit`, `prices.change`, `stock.adjust`,
`purchases.create`, `costs.view`, `reports.view`, `users.manage`,
`settings.manage`, `business.delete`.

### role_permissions: Built (Phase 2)
Which permissions each role has. Role must be in the same business;
permission must be in the fixed list.

### branches: Built (Phase 2)
A shop location; stock is held per branch.
- Columns: `name` (unique per business), `archived_at`.
- V1 assumes every branch is in the business's registered GST state
  (business-rules open question 23).

### devices: Built (Phase 2; invoice prefix in Phase 7)
A till or phone that sells.
- Columns: `branch_id`, `name`, `status` (`active` | `revoked`),
  `last_seen_at`. Phase 7 adds `invoice_prefix` (unique per business), so
  each till has its own invoice series (business rule 5.2).
- A revoked device's next sync is rejected.

---

## 2. Settings and system

### settings: Built (Phase 2; more fields in Phase 4)
One row per business.
- Built: `country_code` (`IN`), `currency_code` (`INR`), `time_zone`
  (`Asia/Kolkata`), `financial_year_start_month` (4 = April),
  `prices_include_tax` (true), `round_off_enabled` (true, open question 5),
  `cashier_discount_limit_bps` (500 = 5%, range 0–10000).
- Phase 4 adds: `legal_name`, address, `gstin` (format-checked),
  `registered_state_code`, `gst_registration` (`registered` |
  `unregistered` | `composition`), `allow_negative_stock_online` (default
  false, rule 7.1), `offline_window_hours` (default 72), and a threshold
  above which a stock adjustment needs a second approver.

### audit_logs: Built (Phase 2), append-only
Who did what, to which record, when.
- Columns: `actor_user_id`, `actor_role` (name at the time), `device_id`,
  `action` (e.g. `invoice.void`), `entity_type`, `entity_id`, `before`,
  `after` (JSON), `ip`, `request_id`, `created_at` (database clock).
- Events (blueprint 5.5): logins and failures, user and role changes, price
  changes, invoice creation and void, payments, returns, stock adjustments,
  purchases, settings, exports, admin actions. Failed logins for an unknown
  email have no business; Phase 3 decides where those go.

### sync_operations: Built (Phase 2), append-only
One row per write a till sends, so a retry returns the stored result
instead of running twice (online and offline).
- Columns: `device_id`, `client_op_id` (unique per business and device),
  `operation`, `status` (`applied` | `rejected` | `flagged`), `result`.
- `flagged` = accepted but needs a manager (e.g. an offline sale into
  negative stock, or the same IMEI sold on two tills).

### rate_limits: Built (Phase 2; used in Phase 3)
Counters for login and password-reset limits. No business data; keys will
be hashes, not raw emails or IP addresses (Phase 3).

### files: Planned (Phase 5)
Uploaded images (product photos, logo, expense receipts).
- Columns: `storage_key` (random, business-prefixed, private storage),
  `content_type` (PNG, JPEG or WebP only), `size_bytes` (≤ 2 MB),
  `sha256`, `purpose`, `uploaded_by`.
- Rules: file type checked by its content (not the name); re-encoded on the
  server to strip metadata; shown only through short-lived signed links.

---

## 3. Catalog (Phase 5)

### categories, brands, units: Planned
Lists used to organise products. All archived, never deleted.
- `categories`: `name`, optional `parent_id` (same business).
- `brands`: `name`.
- `units`: `name`, `code` (e.g. `pcs`, `m`), `allows_fraction` (cloth sold
  by the metre: yes; shirts: no).
- Names unique per business, ignoring case.

### products: Planned
What the shop sells, before size/colour.
- Columns: `name`, `category_id`, `brand_id`, `unit_id`, `hsn_code`,
  `tax_category` (links to `tax_rates`), `attributes` (JSON, validated by
  the business template: brand, model, fabric...), `track_serial` (mobile
  phones: each unit has an IMEI), `warranty_months`, `archived_at`.
- Rule: every product has at least one variant (a plain item has one
  default variant).

### product_variants: Planned
The thing actually stocked and sold: e.g. "Shirt, blue, M".
- Columns: `product_id`, `sku` (unique per business, ignoring case),
  `attributes` (size, colour...), `selling_price_paise`, optional
  `mrp_paise` (review question R4), `archived_at`.
- Price changes are audited. A sale stores a snapshot of the price, so a
  later change never alters old invoices.

### barcodes: Planned
- Columns: `variant_id`, `code`. Unique `(tenant_id, code)`: a scan finds
  exactly one item. A variant may have several barcodes.

### serial_numbers: Planned
One row per physical unit of a serial-tracked product (IMEI).
- Columns: `variant_id`, `serial` (unique per business), `status`
  (`in_stock` | `sold` | `returned` | `scrapped`), `branch_id`,
  `purchase_item_id`, `invoice_item_id`, `warranty_ends_on`.
- Rule: an IMEI can be sold only once until it is returned. If two offline
  tills sell the same IMEI, the first to sync wins and the second is
  flagged.

---

## 4. Tax (Phase 4)

### tax_rates: Planned
GST rates as data, never hardcoded (business rule 4).
- Columns: `country_code`, `tax_category`, `label` (e.g. `TEST 5%`),
  `rate` (`numeric(7,4)`), `price_min_paise` / `price_max_paise` per piece
  (for clothing slabs, optional), `effective_from`, `effective_to`
  (optional), `is_test`.
- Rules: date ranges for the same category and price range may not overlap
  (database exclusion constraint). A rate change is a new row; old invoices
  keep the rate in their own line snapshot. Development uses only the
  clearly labelled `TEST` rates until the accountant supplies real slabs
  (open questions 1 and 2).
- Proposed: global (the law is the same for every business), read-only for
  the app, maintained by you. Review question R1.

---

## 5. Sales (Phase 7)

### invoice_sequences: Planned
The counter behind invoice and credit-note numbers.
- Columns: `document_type` (`invoice` | `credit_note`), `series_prefix`
  (per till), `financial_year` (e.g. `2026-27`), `next_number`.
- Unique per business, type, prefix and year. Taken inside the sale
  transaction with a row lock, so numbers never repeat and a failed sale
  does not use one up (rule 5.3). Open questions 3, 4 and 20 (parallel
  series, format, yearly restart).

### invoices: Planned; posted invoices are never edited
- Columns: `branch_id`, `device_id`, `client_op_id`, `series`, `number`,
  `invoice_number` (formatted, e.g. `INV-2026-27-000001`), `status`
  (`posted` | `voided`), `customer_id` (optional), `place_of_supply_state`,
  `issued_at` (server time), `device_time`, `prices_include_tax` (snapshot),
  `subtotal_paise`, `discount_paise`, `taxable_paise`, `cgst_paise`,
  `sgst_paise`, `igst_paise`, `round_off_paise`, `total_paise`,
  `void_reason`, `voided_at`, `voided_by`.
- Rules (blueprint 6.3):
  - unique `(tenant_id, series, number)`: no duplicate numbers;
  - check: `total = subtotal − discount + tax + round_off`, and
    `tax = cgst + sgst + igst`;
  - trigger: a posted invoice can change only once, from `posted` to
    `voided` with a reason, and nothing else ever changes;
  - no DELETE.
- Void (manager or above, reason required) adds reversing stock, payment
  and ledger rows; the original rows stay as they were (rule 6.3). Open
  question 8 (void time limit).

### invoice_items: Planned, append-only
One line of an invoice, with a snapshot of everything at the time of sale
(rule 4.7).
- Columns: `invoice_id`, `line_no`, `variant_id`, `serial_id` (optional),
  snapshot `name`, `sku`, `hsn_code`, `unit_price_paise`, `quantity`,
  `discount_paise`, `taxable_paise`, `tax_rate`, `cgst_paise`,
  `sgst_paise`, `igst_paise`, `line_total_paise`, `unit_cost_paise`
  (weighted average at sale time, for stable profit reports),
  `warranty_ends_on`, `price_override_reason` (if a permitted user changed
  the price; audited).
- Rules: per-line tax rounded half up to the paisa (rule 3.2); CGST = SGST
  for same-state sales, IGST otherwise (rule 4.4).

### invoice_payments: Planned, append-only
- Columns: `invoice_id`, `method` (`cash` | `upi` | `card` | `credit`),
  `amount_paise` (negative for a refund or void reversal), `reference`,
  `received_at`.
- Rule: payments add up to the invoice total, or the remainder goes on the
  customer's account within their credit limit (blueprint 7.5).

### returns and return_items: Planned, append-only
A return is a credit note with its own number series (rule 5.4).
- `returns`: `original_invoice_id`, `credit_note_number`, `reason`,
  refund method, totals (same columns as invoices).
- `return_items`: `original_invoice_item_id`, `quantity`, `resellable`
  (yes: back into stock; no: scrapped with a reason code), amounts and tax
  taken from the original line snapshot (open question 9).
- Rule: returned quantity can never exceed sold quantity minus earlier
  returns (checked in the service, inside the transaction with a lock).
  An exchange is a return plus a new invoice in one transaction (open
  question 11). Open questions 10, 12, 13.

### held_carts: Planned
A cart parked at the till ("hold bill") to serve the next customer.
- Columns: `device_id`, `user_id`, `payload` (JSON), `expires_at`.
- Not a financial record: may be deleted when recalled or expired.

---

## 6. Purchasing (Phase 6)

### purchases: Planned; posted purchases are never edited
- Columns: `supplier_id`, `supplier_invoice_number`, `purchase_date`,
  `branch_id`, totals in paise (same split as invoices), `status`
  (`posted` | `voided`).
- Rule: unique `(tenant_id, supplier_id, supplier_invoice_number)`, so the
  same supplier bill cannot be entered twice.

### purchase_items: Planned, append-only
- Columns: `purchase_id`, `variant_id`, `quantity`, `unit_cost_paise`,
  tax columns, `line_total_paise`, and serials received (for IMEI items).

### purchase_payments: Planned, append-only
- Columns: `purchase_id`, `amount_paise`, `method`, `paid_at`, `reference`.

### purchase_returns (and purchase_return_items): Planned, append-only
Goods sent back to a supplier.
- `purchase_returns`: `original_purchase_id`, `reason`, totals.
- `purchase_return_items` (proposed, not in the blueprint list):
  `original_purchase_item_id`, `quantity`, amounts. Review question R2.

---

## 7. Inventory (Phase 6)

### stock_movements: Planned, append-only ledger (source of truth)
Every change in stock is a new row; nothing is ever edited (rule 7.4).
- Columns: `branch_id`, `variant_id`, `movement_type` (`PURCHASE_IN`,
  `SALE_OUT`, `SALE_RETURN_IN`, `PURCHASE_RETURN_OUT`, `ADJUSTMENT_IN`,
  `ADJUSTMENT_OUT`, `TRANSFER_IN`, `TRANSFER_OUT`, `OPENING_STOCK`,
  `VOID_REVERSAL`), `quantity` (signed: `_IN` positive, `_OUT` negative,
  checked), `unit_cost_paise`, `reason_code` (required for adjustments),
  `source_type`, `source_id`, `source_line_id`, `device_time`.
- Rules: unique `(tenant_id, source_type, source_line_id, movement_type)`,
  so a retried sale cannot post stock twice; no UPDATE/DELETE for anyone.

### stock_balances: Planned (fast cache, rebuildable)
Current quantity and average cost per variant per branch.
- Columns: `variant_id`, `branch_id`, `quantity`, `average_cost_paise`.
- Rules: unique `(tenant_id, variant_id, branch_id)`; updated in the same
  transaction as the movement; always rebuildable from `stock_movements`
  (a script compares the two). Sales lock balances in a fixed order (by
  variant id) to avoid deadlocks, and decrease stock only if enough remains
  (online). It may go below zero only through a flagged offline sale
  (rule 7.2). Average cost is kept per branch (open question 22);
  its precision is open question 24.

---

## 8. Customers, suppliers and balances (Phases 6–8)

### customers: Planned (Phase 7, for credit sales)
- Columns: `name`, `phone`, `email`, `gstin` (B2B, open question 17),
  `state_code`, `credit_limit_paise`, `archived_at`.
- Proposed: phone unique per business when given (review question R5).

### suppliers: Planned (Phase 6)
- Columns: `name`, `phone`, `gstin`, `state_code`, `archived_at`.

### party_ledger_entries: Planned, append-only
Every amount owed by a customer or owed to a supplier (blueprint 6.2).
Balances are **never** a stored number someone can edit; they are the sum
of these rows.
- Columns: `customer_id` or `supplier_id` (exactly one, checked),
  `entry_type` (`opening` | `invoice` | `payment` | `return` | `purchase` |
  `purchase_return` | `adjustment` | `void_reversal`), `amount_paise`
  (signed: positive = they owe us), `source_type`, `source_id`.

---

## 9. Expenses (Phase 8)

### expense_categories: Planned
- Columns: `name` (unique per business), `archived_at`.

### expenses: Planned; never deleted
- Columns: `category_id`, `branch_id`, `amount_paise`, `paid_on`, `method`,
  `note`, `receipt_file_id`, `status` (`posted` | `voided`), `void_reason`.
- A mistake is voided with a reason, like an invoice.

---

## Review questions

Decisions this design needs. Each has the default that will be used if
nobody objects.

| # | For | Question | Default |
|---|---|---|---|
| R1 | Developer, accountant | Should `tax_rates` be global (same law for every business, maintained by you) or per business (each shop keeps its own)? | Global, read-only for the app. A business cannot change tax law by mistake, and a rate update reaches everyone at once. |
| R2 | Developer, accountant | Add `purchase_return_items` (not in the blueprint list), so a supplier return can cover some lines and quantities of a purchase? | Yes. |
| R3 | Accountant | Average cost precision: stock bought at ₹100 for 3 pieces costs ₹33.333 each. Keep average cost in whole paise (small rounding drift), or with extra decimals (e.g. 1/10,000 paisa) and round only on reports? | Extra precision for average cost only; all invoice and ledger amounts stay whole paise. Business-rules open question 24. |
| R4 | Accountant, owner | Should variants carry an MRP (maximum retail price), and must it print on the bill or tag? | Optional `mrp_paise` field; not printed until confirmed. Business-rules open question 25. |
| R5 | Owner | Must a customer's phone number be unique within a business (one customer record per phone)? | Yes, when a phone is given. |
| R6 | Developer | Failed logins for an unknown email have no business. Keep them out of `audit_logs` (in a separate security log) rather than allow an empty `tenant_id`? | Separate log, decided in Phase 3. |

Also waiting on the accountant: open questions 1–25 in
[business-rules.md](business-rules.md), especially 1–4 (rates, slabs, invoice
series) before Phase 7, and 21–25 (stock costing, branches, MRP) before
Phase 6.

## Reviewer sign-off

| Reviewer | Date | Agreed / changes requested |
|---|---|---|
| Owner | 2026-10-01 | Agreed; defaults accepted for R1–R6 |
| Experienced developer | | |
| Accountant (sections 4–9) | | |
