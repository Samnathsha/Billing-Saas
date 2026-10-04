import { expect, type Page } from "@playwright/test";
import { logIn, test } from "../flows/helpers";
import { stockOf } from "../flows/shop";
import { newTillPage, offlineShop, registerTill, sellOffline, tillStatus, waitForSync } from "./shop";

// Offline tills in a real browser with the network switched off and on
// (blueprint 8.6 and the Phase 10 "done when"), against a production build.

const OPERATIONS = "**/api/sync/operations";

async function billsListed(page: Page, number: string): Promise<number> {
  await page.goto("/sales");
  return page.getByText(number, { exact: true }).count();
}

test("sell offline (the till page reloads without internet), then sync: one bill with the till's number, stock down; logging out warns first", async ({ page, context }) => {
  await offlineShop(page, { quantity: 5 });
  await registerTill(page, "T1");

  await context.setOffline(true);
  await page.reload();
  await expect(tillStatus(page)).toContainText("Offline billing");
  const number = await sellOffline(page, "SH-M", { cash: "1000" });
  expect(number).toMatch(/^T1\/\d{2}-\d{2}\/00001$/);
  await expect(tillStatus(page)).toContainText(/(^|\D)1 waiting to sync/);

  // Logging out with an unsent bill: a blocking warning first.
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("alertdialog", { name: "Bills not sent yet" })).toContainText("1 bill(s) or return(s)");
  await page.getByRole("button", { name: "Stay logged in" }).click();

  await context.setOffline(false);
  await waitForSync(page);
  expect(await billsListed(page, number)).toBe(1);
  expect(await stockOf(page)).toBe("4");
});

test("done when: 30 bills with Wi-Fi off all arrive once, with correct stock", async ({ page, context }) => {
  test.setTimeout(300_000);
  await offlineShop(page, { quantity: 40 });
  await registerTill(page, "T2");
  await context.setOffline(true);
  const numbers: string[] = [];
  for (let i = 0; i < 30; i += 1) numbers.push(await sellOffline(page, "SH-M", { cash: "799" }));
  expect(new Set(numbers).size).toBe(30);
  await expect(tillStatus(page)).toContainText(/(^|\D)30 waiting to sync/);
  await context.setOffline(false);
  await waitForSync(page);
  await page.goto("/sales");
  for (const n of numbers) await expect(page.getByText(n, { exact: true }), n).toHaveCount(1);
  expect(await stockOf(page)).toBe("10");
});

test("the same operation sent twice creates one bill", async ({ page, context }) => {
  await offlineShop(page, { quantity: 5 });
  await registerTill(page, "T3");
  await context.setOffline(true);
  const number = await sellOffline(page, "SH-M", { cash: "799" });
  const sent: { body: string; token: string }[] = [];
  await page.route(OPERATIONS, async (route) => {
    sent.push({ body: route.request().postData() ?? "", token: (await route.request().allHeaders())["x-till-token"] ?? "" });
    await route.fulfill({ response: await route.fetch() });
  });
  await context.setOffline(false);
  await waitForSync(page);
  // Send exactly the same operation again, as a till whose answer was lost.
  const first = sent[0];
  if (first === undefined) throw new Error("nothing was sent");
  const again = await page.request.post("/api/sync/operations", { data: first.body, headers: { "content-type": "application/json", "x-till-token": first.token, origin: new URL(page.url()).origin } });
  expect(again.status()).toBe(200);
  expect(await again.json()).toMatchObject({ number, repeat: true });
  expect(await billsListed(page, number)).toBe(1);
  expect(await stockOf(page)).toBe("4");
});

test("the browser closed in the middle of a sync loses nothing and sends nothing twice", async ({ page, context }) => {
  await offlineShop(page, { quantity: 5 });
  await registerTill(page, "T4");
  await context.setOffline(true);
  const number = await sellOffline(page, "SH-M", { cash: "799" });
  // The server saves the bill, but the till is closed before it hears back.
  let calls = 0;
  await context.route(OPERATIONS, async (route) => {
    calls += 1;
    if (calls === 1) {
      await route.fetch();
      await page.close();
      return;
    }
    await route.fulfill({ response: await route.fetch() });
  });
  await context.setOffline(false);
  await expect.poll(() => page.isClosed(), { timeout: 30_000 }).toBe(true);
  const reopened = await newTillPage(context);
  await waitForSync(reopened);
  expect(calls).toBeGreaterThanOrEqual(2);
  expect(await billsListed(reopened, number)).toBe(1);
  expect(await stockOf(reopened)).toBe("4");
});

test("two tills sell the same IMEI offline: exactly one flagged conflict for a manager", async ({ page, browser, context }) => {
  const email = await offlineShop(page, { quantity: 1, imeis: ["356938035643809"] });
  await registerTill(page, "M1");
  const other = await browser.newContext({ extraHTTPHeaders: { "X-Forwarded-For": "10.9.9.9" } });
  const till2 = await other.newPage();
  await logIn(till2, email);
  await expect(till2).toHaveURL(/\/dashboard$/);
  await registerTill(till2, "M2");

  await context.setOffline(true);
  await other.setOffline(true);
  await sellOffline(page, "PH-1", { cash: "15000", imei: "356938035643809" });
  await sellOffline(till2, "PH-1", { cash: "15000", imei: "356938035643809" });
  await context.setOffline(false);
  await other.setOffline(false);
  await waitForSync(page);
  await waitForSync(till2);

  await page.goto("/settings/tills/flags");
  await expect(page.getByRole("listitem", { name: "imei_unavailable" })).toHaveCount(1);
  await expect(page.getByRole("listitem", { name: "imei_unavailable" })).toContainText("IMEI 356938035643809");
  await other.close();
});

test("a return queued before its sale is sent after it, even when the sale needs a retry", async ({ page, context }) => {
  await offlineShop(page, { quantity: 5 });
  await registerTill(page, "T5");
  await context.setOffline(true);
  const number = await sellOffline(page, "SH-M", { cash: "1600" });
  await page.getByRole("tab", { name: "Return (this till's bills)" }).click();
  await page.getByRole("button", { name: new RegExp(number.replace(/\//g, "\\/")) }).click();
  await page.getByLabel("Return quantity of Cotton Shirt · M").fill("1");
  await page.getByLabel("Reason").fill("Wrong size");
  await page.getByRole("button", { name: "Save return offline" }).click();
  await expect(page.getByRole("heading", { name: /^Credit note T5R\/\d{2}-\d{2}\/00001$/ })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  // The first attempt at the sale fails on the server side: the return must
  // not overtake it.
  const order: string[] = [];
  let first = true;
  await page.route(OPERATIONS, async (route) => {
    order.push((JSON.parse(route.request().postData() ?? "{}") as { number: string }).number);
    if (first) {
      first = false;
      await route.fulfill({ status: 500, json: { code: "SERVER", message: "Something went wrong." } });
      return;
    }
    await route.fulfill({ response: await route.fetch() });
  });
  await context.setOffline(false);
  await waitForSync(page);
  expect(order[0]).toBe(number);
  expect(order[1]).toBe(number);
  expect(order[2]).toMatch(/^T5R\//);
  // Sold one, took it back (resellable): 5 again.
  expect(await stockOf(page)).toBe("5");
});

test("a revoked till is refused at its next sync, shows what was not sent, saves it as a file, then wipes itself", async ({ page, browser, context }) => {
  const email = await offlineShop(page, { quantity: 5 });
  await registerTill(page, "T6");
  await context.setOffline(true);
  const number = await sellOffline(page, "SH-M", { cash: "799" });

  // Meanwhile a manager revokes the till from another computer.
  const office = await browser.newContext({ extraHTTPHeaders: { "X-Forwarded-For": "10.8.8.8" } });
  const manager = await office.newPage();
  await logIn(manager, email);
  await expect(manager).toHaveURL(/\/dashboard$/);
  await manager.goto("/settings/tills");
  await manager.getByRole("listitem", { name: "Counter T6" }).getByRole("button", { name: "Revoke" }).click();
  await expect(manager.getByRole("listitem", { name: "Counter T6" })).toContainText("revoked");

  await context.setOffline(false);
  await page.goto("/sync");
  const alert = page.getByRole("alert").filter({ hasText: "This till was revoked by a manager." });
  await expect(alert).toBeVisible({ timeout: 30_000 });
  await expect(alert).toContainText("1 bill(s) or return(s) were NOT sent");
  await expect(page.getByRole("row", { name: number })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove this till's data" })).toBeDisabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save unsent items as a file" }).first().click();
  expect((await download).suggestedFilename()).toMatch(/^unsynced-T6-/);
  await page.getByRole("button", { name: "Remove this till's data" }).click();
  await expect(page.getByText("This computer's till data was removed.")).toBeVisible();
  expect(await page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "billing-till"))).toBe(false);
  expect(await billsListed(manager, number)).toBe(0);
  await office.close();
});

test("past the offline window, the till stops billing until it is online again", async ({ page, context }) => {
  await offlineShop(page, { quantity: 5 });
  await registerTill(page, "T7");
  await page.goto("/settings/tills");
  await page.getByLabel(/Tills may bill offline for/).fill("1");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("form", { name: "Offline window" }).getByRole("status")).toHaveText("Saved.");
  // Opening the till online refreshes its copy, which now carries the 1-hour window.
  await page.goto("/pos");
  await expect(tillStatus(page)).toContainText("Everything is sent.");

  await context.setOffline(true);
  // Two hours pass without internet.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("billing-till");
        open.onerror = () => { reject(new Error("open")); };
        open.onsuccess = () => {
          const tx = open.result.transaction("meta", "readwrite");
          const meta = tx.objectStore("meta");
          const get = meta.get("session");
          get.onsuccess = () => {
            const session = get.result as { lastOnlineAt: number };
            meta.put({ ...session, lastOnlineAt: Date.now() - 2 * 3_600_000 });
          };
          tx.oncomplete = () => { open.result.close(); resolve(); };
          tx.onerror = () => { reject(new Error("write")); };
        };
      }),
  );
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Offline billing has stopped" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save bill offline (F9)" })).toHaveCount(0);
  await context.setOffline(false);
});
