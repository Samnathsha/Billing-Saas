# Offline tills (Phase 10)

How it is built: `docs/decisions/0006-offline-tills.md`. The rules (no
credit offline, returns of this till's bills only, late checks keep the sale
and flag it, 72-hour window): `docs/business-rules.md` section 17 and open
questions 45-48.

## For the shop

1. **Register the till.** On the till computer, a manager opens **Tills**
   (menu) and registers *this computer* with a name and a prefix (e.g.
   `T1`). The computer downloads a copy of the shop: items with selling
   prices (never costs), GST rates, IMEIs in stock at its branch, the
   business details, and its bills from the last return-window days.
2. **Open New bill once while online.** The browser then keeps the till
   page, so it opens even without internet.
3. **No internet:** the New bill page switches to **Offline billing** by
   itself (or press *Bill offline* on a shaky connection). Bills must be
   fully paid (cash, UPI, card), walk-in customers only. The receipt says
   **PENDING SYNC** and carries the till's number (`T1/26-27/00001`).
   Returns of bills made on this till: the *Return* tab (credit notes
   `T1R/…`).
4. **Internet back:** the bills are sent by themselves, oldest first. The
   strip on New bill and the **Sync status** page show what waits, the
   oldest, and anything refused with the reason (retry, or save it as a
   file for a manager).
5. **Check what no longer fitted:** Tills → *Offline bills to check*: a
   price or GST rate that changed meanwhile, stock that went below zero,
   an IMEI sold by two tills, a discount above the limit, a seller whose
   role was removed, a wrong clock, a skipped number, a return after the
   return period, a refund worked out differently. The bill is kept as the
   customer paid it; write what was done and mark it reviewed.
6. **Offline window:** a till bills offline for 72 hours after its last
   online contact (Owner/Admin can change it on the Tills page). After
   that it must connect again.
7. **Logging out** with unsent bills shows a warning; the bills stay on the
   till and are sent when someone logs in there. After logging out, nobody
   can bill offline on that computer until someone logs in online.
8. **Revoking a till** (lost or stolen computer): Tills → *Revoke*. Its
   next sync is refused; the till shows what was not sent, lets it be
   saved as a file, then removes its data.

## How it works

- **Service worker** (`src/serwist/sw.ts`, production builds only): keeps
  the app's files and the till and Sync pages; never API answers or other
  pages. Never reloads the page when the internet returns; a new app
  version waits until every tab is closed (never during a sale).
- **Till store** (`src/lib/till/`, Dexie/IndexedDB): the shop's copy, the
  till's numbers, kept bills and the **outbox**. Each offline bill or
  return is saved together with its outbox entry and its number in ONE
  transaction. The numbers never go below what the server has seen.
- **Same maths as the server** (`src/lib/offline-bill.ts`, `bill-maths`,
  `tax-pick`, `return-maths`): the server works each offline bill out again
  and refuses it if the totals differ.
- **Sync engine** (`src/lib/till/sync.ts`): one entry at a time in the
  order made; done only when the server confirmed; no answer or server
  error → retry after 1 s, 2 s, 4 s … up to 5 minutes with jitter; refused
  (422) → failed list; 409 (its bill has not arrived) → retry; 401/403 →
  wait; 410 → revoked. One sync per browser (Web Locks).
- **Server** (`POST /api/sync/operations`, `GET /api/sync/snapshot`): the
  session (the business comes only from it) AND the till's token (only its
  SHA-256 is stored). Each operation is its own transaction; a repeat
  returns the first result (`sync_operations`). Checks the person's
  CURRENT role. Refuses what cannot be right (a number outside the till's
  series or used twice, totals that do not add up, a GST rate the item
  never had, an unknown item or seller, not fully paid, a return of
  another till's bill or of more than was sold); keeps and flags the rest
  (`sync_flags`, only open → resolved).
- **Stock** may go below zero only for an offline bill (stock service rule;
  online sales and everything else still refuse). The stock rebuild check
  accepts that and nothing else.

## Tests

- `tests/integration/offline-sync.test.ts` (23): tills, the copy (no
  costs), applied once, 30 in parallel and twice, every flag, every
  refusal, returns (incl. before their sale), two tills one IMEI, flags,
  the window setting. Mutation-checked (5).
- `src/lib/till/sync.test.ts` (12), `src/lib/offline-bill.test.ts` (8):
  store transactions, numbers, window, engine order/backoff/failed/
  revoked.
- `npm run test:offline` (local only, production build, network really
  off; `tests/offline/`): the till page offline; sell offline then sync;
  **30 bills offline arrive once with the right stock**; the same
  operation twice → one bill; the browser closed mid-sync → nothing lost
  or doubled; two tills one IMEI → exactly one flag; a return queued
  before its sale (sale retried first); a revoked till (save file, wipe);
  the expired window; the logout warning. Mutation-checked (3).

## Phase 10 sign-off

**Before going live** the owner runs the hand check in
`docs/hand-tests/phase-10-hand-test.pdf` on the real till computer (Wi-Fi
off and on), and the accountant answers questions 45-48.
