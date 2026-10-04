# Offline tills (Phase 10)

How it is built: `docs/decisions/0006-offline-tills.md`. The business rules
(no credit offline, returns of this till's bills only, late checks keep the
sale and flag it): `docs/business-rules.md` section 17.

## 10.1 Installable app and service worker

- `src/app/manifest.ts`: the app can be installed; it opens on the till
  (`/pos`).
- `src/serwist/sw.ts` (served at `/serwist/sw.js`): keeps on the computer
  only the app's built files and the till page (the newest copy when online,
  the kept copy when offline). Nothing else: no API answers, no other pages
  (some show costs and profit). A login page reached by redirect is never
  kept.
- It runs only in a production build (`npm run build && npm start`); the
  development server has no service worker.
- It never reloads the page when the internet returns (a sale may be open),
  and a new app version waits until every tab of the app is closed, so it
  never switches over in the middle of a sale.
- The Content Security Policy allows workers and the manifest only from this
  site (`worker-src 'self'`, `manifest-src 'self'`).

**To be done in 10.6:** logging out clears the kept till page.

## Tests

- `npm run test:offline` (local only, like the flow tests): builds the app,
  starts it on port 3300 against the local throwaway database, and switches
  the browser's network off and on (`tests/offline/`). A production server
  sends only real email, so the test's login is created directly in the
  local database (`tests/offline/account.ts`).
- `pwa.spec.ts`: the till reloads with the internet off (proved to come from
  the kept copy), other pages are unavailable offline and never kept, the
  app can be installed. Mutation-checked: keeping the reports page, or not
  keeping the till page, both fail the test.
