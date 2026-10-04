# 0006: Offline tills: service worker, local store, outbox and sync

- Status: Accepted
- Date: 2026-10-04
- Decided by: owner (Phase 10 rules: business rules section 17) and the
  blueprint (section 8); this record fixes how it is built
- Builds on: business rules 5.2, 7.2, 9.2 and 17; blueprint 8.1–8.6

## Context

A till must keep billing when the internet drops, without ever losing a
bill or counting one twice. The server's database stays the only authority
(blueprint 8): what is saved on a till is not saved in the business until the
server confirms it.

## Decision

1. **Installable app with a service worker (Serwist 9).** The till page and
   the app's static files are cached so the till opens and reloads without
   internet. Serwist is the option the Next.js guide names, supports this
   version's build tool (Turbopack), is free and open source. A new app
   version waits and is applied only when no sale is open and the outbox is
   idle (blueprint 8.4).
2. **Local store: Dexie 4 (IndexedDB).** Holds only what a till needs and the
   role may see: items with selling price, GST rate and IMEI flag (never cost
   prices), the business details for the receipt, this till's recent bills
   (for offline returns), the till's identity, and the **outbox**. No
   passwords; the till's token is stored as given by the server and can be
   revoked.
3. **Registered tills with their own bill series.** A till is registered by
   a manager; it gets its own prefix (e.g. `T1`, 1–4 characters, different
   from the business's prefixes) and a random device token (the server keeps
   only its hash). **Offline bills only** are numbered on the till from its
   own series, so they never clash with the server's numbers or another till
   (accountant question 3: parallel series). Online bills keep using the
   server's series exactly as today.
4. **One local transaction per offline bill.** The bill and its outbox entry
   are saved together in one IndexedDB transaction; the receipt shows
   "pending sync".
5. **Sync engine.** Sends outbox entries one at a time in creation order
   (a return never arrives before its sale). Network and server errors retry
   with exponential backoff and jitter (1 s, 2 s, 4 s … up to 5 minutes);
   validation errors do not retry and go to a visible "failed" list. An
   entry is marked synced only after the server confirms.
6. **Server endpoint `/api/sync/operations`.** Needs the logged-in session
   AND the till's token; refuses revoked tills. Each operation runs in its own
   transaction, keyed by `(business, till, client_op_id)` in
   `sync_operations`, so a repeat returns the stored result. Everything is
   recomputed and revalidated on the server with the person's CURRENT
   permissions.
7. **Late checks keep the sale (business rules 17).** If an offline bill no
   longer fits (stock short, discount over the limit, price changed, item
   archived, IMEI already sold, role removed), the bill is saved as the
   customer paid it and a **flag** is recorded for a manager. To keep a sale
   that already happened, stock may go below zero **only through this sync
   path**; online sales still never go below zero (the database check moves
   from the table into the stock service, which keeps refusing it online).
8. **Offline window and revoking.** A till sells offline only within 72 hours
   of its last online contact (business setting). A revoked till is refused at
   its next sync, shows what was unsynced (with an export) and wipes its local
   data.
9. **Tests** (blueprint 8.6) run in a real browser with the network switched
   off and on: sell offline then sync, the same operation twice, the browser
   closed mid-sync, two tills selling one IMEI, a return queued before its
   sale, a revoked till, an expired offline window.

## Consequences

- Two numbering paths (server series online, till series offline). Both are
  gap-free on their own; a till's numbers are kept in its local store, so a
  wiped till with unsynced bills is the one way to lose numbers (shown to the
  owner before wiping).
- Stock can be negative after offline sales; managers see it on the flags
  screen and correct it (count correction or purchase).
- New dependencies: `serwist`, `@serwist/turbopack`, `dexie` (and
  `fake-indexeddb` for tests). All free and open source.
