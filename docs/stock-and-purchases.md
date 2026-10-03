# Stock, suppliers and purchases (Phase 6)

Business rules: `docs/business-rules.md` section 14 and open questions
32–35. Storage and the rebuild check: `docs/decisions/0004-stock-ledger-order-and-size.md`.

## Screens

| Screen | Who | What |
| --- | --- | --- |
| Stock (`/inventory`) | everyone in the business | Quantity per item and branch; average cost only with "View cost price and profit" |
| Opening stock (`/inventory/opening`) | "Stock adjustment" | What is on the shelves on day one; once per item and branch |
| Adjust stock (`/inventory/adjust`) | "Stock adjustment" | Damaged, lost, expired, found, count correction, other; always with a reason |
| Suppliers (`/suppliers`) | "Create purchase" to change; reports can view | List with what we owe each; add a supplier |
| Supplier (`/suppliers/<id>`) | same | Account history, payments, opening balance (once), details, archive |
| Purchases (`/purchases`) | same | All bills, newest first |
| New purchase (`/purchases/new`) | "Create purchase" | A supplier's bill: lines by SKU or barcode, price before GST, GST %, IMEIs, money paid now |
| Purchase (`/purchases/<id>`) | same | Lines and totals; void (also needs "Void a posted invoice") |

## How it works

- **Stock** changes only through `postMovements` (`src/modules/inventory/stock.ts`):
  one append-only movement per change, balance rows locked in a fixed order,
  never below zero, weighted average cost in exact decimals.
- **A supplier's balance** is the sum of append-only account rows (opening
  balance, purchases, payments, voids). Positive: we owe them. Negative: an
  advance with them.
- **A purchase** is one transaction: bill, lines, stock in, IMEI numbers,
  supplier account, payment and audit, with an idempotency key (a double
  click or a retry saves once). The same supplier bill number cannot be
  entered twice for one supplier.
- **Cost:** a registered (regular) business counts cost without GST; a
  composition or unregistered business counts it with GST. Purchases are
  refused until the GST registration is set in Business settings.
- **A wrong purchase** is never edited: it is voided (stock and account
  reversed, or nothing at all if some stock is gone), then entered again.
  The database itself refuses any other change to a posted purchase.
- **Screens** send item codes and typed rupees only; the business and user
  always come from the session. Amounts become integer paise exactly.

## Checking stock

`npm run stock:rebuild -- <dev|test> <business id>` replays one business's
history and lists any balance that does not match. Read-only.

## Tests

- `tests/integration/suppliers.test.ts`, `purchases.test.ts`, `stock.test.ts`,
  `stock-rebuild.test.ts`, `lookups.test.ts`
- `src/modules/purchasing/maths.test.ts`, `scripts/lib/stock-replay.test.ts`
- `tests/flows/purchases.spec.ts` (through the screens)
- Isolation suites cover the five new tables.

## Phase 6 sign-off (2026-10-03)

The owner tested by hand, on the dev database: the new menu (Stock,
Purchases, Suppliers); the stock list; opening stock for one item (5 at
₹100); adding a supplier; a purchase of 10 at ₹50 + 5% GST (bill total
₹525.00) with ₹200 paid in cash; the supplier balance (₹325.00 owed); and
the new stock quantity and average cost. The owner then signed off Phase 6
("I am satisfied with it").

Covered by the automated browser test instead of by hand
(`tests/flows/purchases.spec.ts`, passing): the same bill number refused,
voiding a purchase (stock, cost and supplier balance restored; the money
paid kept as an advance), a stock adjustment, "not enough stock", and what
a cashier may and may not see.

Still open: accountant questions 32–35 (`docs/business-rules.md`).

Final checks (2026-10-03): unit, local database (all files) and browser
tests pass. On Neon, 756 of 758 database tests passed; the two failures
were "timeout exceeded when trying to connect" in the 100-simultaneous-
sales stock test, where 100 transactions queue for 10 connections over a
slow link. That test passes 10 runs in a row locally and runs in CI on
every push; nothing was oversold or saved wrongly on Neon.
