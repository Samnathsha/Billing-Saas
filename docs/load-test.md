# Load test (Phase 11, step 9)

A light check that login, product search and saving bills stay fast with
several people at once. Tool: **k6** (`tests/load/k6.js`); data:
`npm run load:fixture` (a GST shop, 40 items, 5 tills with 200 ready bills
each, in the LOCAL test database).

## How to run

1. `npm run load:fixture` (local database).
2. Build and start the app on port 3500 against the local database.
3. `k6 run -e BASE=http://localhost:3500 -e SCENARIO=login tests/load/k6.js`
   (then `search`, then `sales`).

## What each part does

| Part | Load | What is measured |
| --- | --- | --- |
| Login | 10 people at once, 50 logins (each from its own address) | `POST /api/auth/sign-in/email` (Argon2id password check) |
| Product search | 20 people for 60 s | the Products page searching "Load Shirt" |
| Saving bills | 5 tills at once, 200 bills each (3 lines) | `POST /api/sync/operations`: the full sale (prices, GST, bill number, stock, payments, audit) |

## Results (2026-10-04, Apple M1, local production build, local PostgreSQL 18)

| Part | Requests | Per second | Failed | Average | Median | 95% under | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Login | 50 | 48 | 0 | 196 ms | 194 ms | 319 ms | 358 ms |
| Product search | 4,762 | 79 | 0 | 252 ms | 217 ms | 430 ms | 1,038 ms |
| Saving bills | 1,001 | 105 | 0 | 47 ms | 46 ms | 58 ms | 82 ms |

All limits passed: every check right, no failed request, 95% of logins
under 2 s, of searches and bills under 1 s. A first run on a busier
database gave similar results (search 95% under 549 ms, bills 95% under
229 ms).

**What it means:** one shop with 5 tills busy at the same moment is far
inside what the app handles: a bill is saved in about 50 ms, and 5 tills
together saved over 100 bills a second, each exactly once.

## Limits of this test

- Local machine, local database: on the hosted platform (Neon in Singapore
  from India) expect about 0.1-0.5 s more per request, mostly network.
- Re-run against the staging deployment in Phase 12 before the pilot.
