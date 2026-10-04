# 0005: Report speed with 50,000 bills

- Status: Accepted
- Date: 2026-10-04
- Decided by: built and measured in Phase 9; no architecture change

## Context

The blueprint asks that reports with 50,000 invoices load in a few seconds,
using database aggregation with indexes, never loading everything into
memory.

## How the reports work

Every report (`src/modules/reports/repo.ts`) is a few SQL statements with
`GROUP BY`, `FILTER` and, for ageing, window functions (running totals),
over indexed columns: `invoices (tenant_id, invoice_date)`, the bill-line
and payment keys by bill, `credit_notes (tenant_id, credit_note_date)`,
`expenses (tenant_id, paid_on)`. Row-level security limits each query to one
business. Dates are the business's own days (bills carry their local date).

## Measured (2026-10-04)

`npm run test:perf` (`tests/perf/reports.test.ts`), local PostgreSQL 18 on
the development Mac: 50,000 bills of 3 lines each (150,000 lines, 50,000
payments) spread over the last 365 days, in one business.

| Report | Time |
| --- | --- |
| Dashboard (today), first call | 88 ms |
| Dashboard (today), again | 7 ms |
| Sales by day, 1 month | 8 ms |
| Sales by day, 1 year | 50 ms |
| By item, 1 year | 532 ms |
| By staff member, 1 year | 455 ms |
| Money in and out, 1 year | 59 ms |
| Profit, 1 year | 178 ms |
| GST summary, 1 year | 185 ms |

All well under the 5-second limit the test enforces. The year's total was
checked exactly (50,000 bills of ₹2,397).

**One lesson:** in a first run the dashboard took about 5 minutes, measured
right after the 50,000 bills were written in one go, before the database had
refreshed its table statistics (the app's own role may not do that, so the
test's request was silently skipped). With statistics refreshed by the table
owner, as autovacuum does by itself shortly after any large change, the same
dashboard took 88 ms. A real shop never writes 50,000 bills at once, but
after a large import the first report may be slow for a minute.

## Neon

The hosted database adds network time per query (about 5–10 queries per
report): expect roughly 0.2–1 s more per report from India to Singapore.
Re-measure on Neon once a pilot shop has real data.
