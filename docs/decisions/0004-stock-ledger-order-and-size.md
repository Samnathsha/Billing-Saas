# 0004: Stock ledger: replay order, rebuild check and storage size

- Status: Accepted
- Date: 2026-10-03
- Decided by: built in Phase 6 step 6.4; no architecture change (no new
  service, role or dependency)

## Context

Stock balances (`stock_balances`) are a fast copy of what the append-only
ledger (`stock_movements`) says. The blueprint asks for a check that
rebuilds every balance from the ledger and reports any difference, and for
a storage estimate before sales (Phase 7) multiply the rows.

Replaying needs the order in which movements were *applied*. `created_at`
cannot give it: the database stamps it with the transaction's start time,
so when two saves on the same item overlap, the one that started first can
be applied second. For quantities that does not matter; for the weighted
average cost it does.

## Decision

1. **Apply order:** `stock_movements.seq` (migration 0028), an identity
   number taken at insert. `postMovements` inserts only while it holds the
   lock on that item's balance row, so for one item and branch `seq`
   always follows the real order. It is one counter for all businesses, so
   it is never shown in screens or returned in DTOs.
2. **Rebuild check:** `npm run stock:rebuild -- <dev|test> <business id>`
   (`scripts/rebuild-stock.ts`). It reads the ledger and the balances in
   one read-only snapshot as `app_user` (row-level security limits it to
   that business), replays the ledger with integer arithmetic only (BigInt,
   the same rounding as the SQL), and lists every difference. It never
   changes data; a difference is a bug to investigate, never something to
   fix by editing balances. Exit code 1 when anything differs.
   Tested with real activity, including 20 simultaneous saves on one item;
   replaying in a wrong order makes that test fail.
3. **One business per run.** Checking all businesses at once would need a
   role that reads across businesses; that is a security decision for
   later (with its own decision record), not part of Phase 6.

## Storage measured (2026-10-03)

Measured on a local PostgreSQL 18 (same engine and version as Neon) with
10,000 bills' worth of rows: 30,000 stock movements (3 lines a bill), one
audit entry and one idempotency key per bill. Includes indexes.

| Table | Rows | Added | Per row |
| --- | --- | --- | --- |
| stock_movements | 30,000 | 15 MB | 539 bytes (200 data + 345 indexes) |
| audit_logs | 10,000 | 7.9 MB | 809 bytes |
| idempotency_keys | 10,000 | 1.9 MB | 195 bytes |

About **2.6 KB per bill** so far. Phase 7 adds the invoice, its lines, its
payment and customer ledger rows: estimate about **5 KB per bill** in total.

- 10,000 bills: about 50 MB.
- A shop with 100 bills a day: about 36,500 bills, **about 180 MB a year**.
- Neon's free plan allows 0.5 GB per project: enough for development and
  a first pilot shop, not for several shops for a year. Before onboarding
  more shops, the owner decides on a paid plan (owner approval needed for
  paid services, CLAUDE.md).

Indexes are 64% of a stock movement's size. If storage becomes a cost
problem, reviewing them is the first step (each one serves a lookup or a
safety rule today, so none is removed now).

## Consequences

- Every future stock writer must keep using `postMovements` (it takes the
  lock before inserting, which is what makes `seq` trustworthy).
- The rebuild check should be run per business after any incident and
  before Phase 7 sign-off.
- Re-measure after Phase 7 with real invoice tables.
