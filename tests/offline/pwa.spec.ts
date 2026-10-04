import { expect } from "@playwright/test";
import { logIn, test } from "../flows/helpers";
import { shopWithStock } from "../flows/shop";
import { confirmedAccountInDb } from "./account";

const nonceOf = (csp: string | undefined): string | undefined => /'nonce-([^']+)'/.exec(csp ?? "")?.[1];

// Step 10.1: the till page opens again with the internet off; nothing but
// the till page and the app's own files is kept on the computer.
test("the till page reloads offline from the service worker", async ({ page, context }) => {
  await shopWithStock(page, async (p) => {
    const email = await confirmedAccountInDb(p);
    await logIn(p, email);
    return email;
  });

  await page.goto("/pos");
  await expect(page.getByRole("heading", { name: "New bill" })).toBeVisible();
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state)).toBe("activated");

  // The worker does not take over open pages mid-way (no clientsClaim), so
  // the next visit is the first one it handles; that copy is kept.
  expect((await page.reload())?.fromServiceWorker()).toBe(true);
  // Another page is visited online: it must not be kept (it may show costs).
  await page.goto("/reports");
  const online = await page.goto("/pos");
  const keptNonce = nonceOf(online?.headers()["content-security-policy"]);
  expect(keptNonce).toBeDefined();

  await context.setOffline(true);
  const offline = await page.reload();
  await expect(page.getByRole("heading", { name: "New bill" })).toBeVisible();
  // The same nonce proves this copy came from the cache, not the server.
  expect(nonceOf(offline?.headers()["content-security-policy"])).toBe(keptNonce);

  const kept = await page.evaluate(async () => {
    const names = await caches.keys();
    const pages = await (await caches.open("till-pages")).keys();
    return { names: names.sort(), pages: pages.map((r) => new URL(r.url).pathname) };
  });
  expect(kept.pages).toEqual(["/pos"]);
  expect(kept.names.filter((n) => !n.startsWith("serwist-precache"))).toEqual(["app-files", "till-pages"]);
  // Any other page is simply unavailable offline.
  await expect(page.goto("/reports")).rejects.toThrow(/ERR_INTERNET_DISCONNECTED|ERR_FAILED/);
  await context.setOffline(false);
});

test("the app can be installed", async ({ page }) => {
  const response = await page.request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);
  const manifest = (await response.json()) as { start_url: string; display: string };
  expect(manifest.start_url).toBe("/pos");
  expect(manifest.display).toBe("standalone");
  const worker = await page.request.get("/serwist/sw.js");
  expect(worker.status()).toBe(200);
  expect(worker.headers()["content-type"]).toContain("javascript");
});
