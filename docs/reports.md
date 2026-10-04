# Dashboard and reports (Phase 9)

Speed with 50,000 bills: `docs/decisions/0005-report-speed.md`.

## Who sees what

| Page | Needs |
| --- | --- |
| Dashboard figures | "View reports" (Owner, Admin, Manager, Accountant); everyone else gets shortcuts |
| Reports (`/reports`) | "View reports" |
| Profit, Stock value | also "View cost price and profit" |
| Audit log (`/reports/audit`) | "Business and tax settings" (Owner, Admin) |
| CSV download | the same as the report; at most 10 a minute per person; every download is in the audit log |

A cashier gets "Not allowed" on these pages and a refusal from the download
address, even when typing it in (browser test).

## What the numbers mean

- **Days** are the business's own days (India time by default). A bill
  belongs to the day it was made.
- **Sales** = posted bills as charged (with GST, after round-off). Voided
  bills are not counted. **Returns** = credit notes in the same dates.
  **Net sales** = sales − returns.
- **By item / category / staff member** add up line amounts (with GST,
  before each bill's round-off), so they can differ from Sales by a few
  paise per bill.
- **Money in and out**, per method: received (bill payments, including the
  negative rows of a same-day void, plus customer payments), refunded (money
  back on returns), expenses, and what is left. Exchange credit is not money.
- **Profit** = net sales without GST − cost of what was sold (the average
  cost at each sale, minus the cost of resellable returns; damaged returns
  stay as cost). **Net profit** subtracts expenses. (Open question 44.)
- **Stock value** = quantity × average cost, per branch.
- **Low stock** = items at or below their reorder level (only items with a
  reorder level set).
- **Customers owe / We owe suppliers**: the balance, split by how long it has
  been owed; payments and credits count against the oldest amounts first.
- **GST summary**: GST on sales by rate minus credit notes; GST on purchases
  (registered businesses only) minus returns to suppliers. For checking
  only: **validate with the accountant**.

## Checking a day by hand (blueprint "done when")

Pick a day with a few bills. Add up the bills' totals on the Bills page for
that day (voided ones not counted) and subtract that day's credit notes. The
Reports → Sales by day figure for that day must be the same. The automated
test `tests/integration/reports.test.ts` does this for a fixed day; the
browser test `tests/flows/reports.spec.ts` checks the dashboard, profit and a
CSV file.

## Tests

- `tests/integration/reports.test.ts`: hand-worked day (sales, returns,
  voids, payments, profit, GST, stock value), two time zones, ageing (FIFO,
  and seen from 45 days later), roles, other businesses
- `src/lib/csv-write.test.ts`: spreadsheet-safe CSV (formula cells defused)
- `tests/flows/reports.spec.ts`: dashboard, reports, CSV download and its
  limit, a cashier kept out
- `tests/perf/reports.test.ts` (`npm run test:perf`, local only): 50,000 bills
