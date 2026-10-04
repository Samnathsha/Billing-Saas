/// <reference lib="webworker" />
import { CacheFirst, NetworkFirst, NetworkOnly, Serwist, type PrecacheEntry, type SerwistGlobalConfig } from "serwist";

// The service worker (decision 0006). It caches only what a till needs to
// open and reload without internet:
// - the app's built files (they never change once built: cache first);
// - the till page itself (fresh when online, the last copy when offline).
// Nothing else is cached: no API answers, no other pages (some show cost
// and profit; blueprint 8.5). A new version waits until every tab of the app
// is closed, so it never switches over in the middle of a sale (8.4).

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const TILL_PAGES = new Set(["/pos", "/sync"]);

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: false,
  clientsClaim: false,
  navigationPreload: false,
  runtimeCaching: [
    { matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/_next/static/"), handler: new CacheFirst({ cacheName: "app-files" }) },
    {
      matcher: ({ request, url, sameOrigin }) => sameOrigin && request.mode === "navigate" && TILL_PAGES.has(url.pathname),
      handler: new NetworkFirst({
        cacheName: "till-pages",
        networkTimeoutSeconds: 4,
        // Keep only a real till page: never a login page reached by redirect
        // or an error page.
        plugins: [{ cacheWillUpdate: ({ response }) => Promise.resolve(response.status === 200 && !response.redirected ? response : null) }],
      }),
    },
    { matcher: () => true, handler: new NetworkOnly() },
  ],
});

serwist.addEventListeners();
