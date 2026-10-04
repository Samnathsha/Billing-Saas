import { expect, type BrowserContext, type Page } from "@playwright/test";
import { logIn } from "../flows/helpers";
import { confirmedAccountInDb } from "./account";

// Shops for the offline tests (production build, no email): a GST
// registered shop in Tamil Nadu with one item in stock, either Cotton
// Shirt M (SKU SH-M, ₹799) or a phone (SKU PH-1, ₹15,000) with IMEIs.
export async function offlineShop(page: Page, opts: { quantity: number; imeis?: string[] }): Promise<string> {
  const phone = opts.imeis !== undefined;
  const email = await confirmedAccountInDb(page, "till-owner");
  await logIn(page, email);
  await page.getByLabel("Business name").fill("Offline Shop");
  if (phone) await page.getByLabel("Mobile phone shop").check();
  await page.getByRole("button", { name: "Create my business" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto("/settings/business");
  await page.getByLabel("Address", { exact: true }).fill("12 Market Road");
  await page.getByLabel("City").fill("Chennai");
  await page.getByLabel("State").selectOption("33");
  await page.getByLabel("PIN code").fill("600001");
  await page.getByLabel("Registered (regular)").check();
  await page.getByLabel("GSTIN").fill("33ABCDE1234F1Z7");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");

  await page.goto("/catalog/products/new");
  const form = page.getByRole("form", { name: "New product" });
  await form.getByLabel("Product name").fill(phone ? "Phone" : "Cotton Shirt");
  await form.getByLabel("Unit", { exact: true }).selectOption({ label: "Piece (pcs)" });
  await form.getByLabel("Tax rate").selectOption({ label: "TEST 5%" });
  if (phone) await form.getByLabel("Model").fill("X1");
  const v1 = form.getByRole("group", { name: "Variant 1" });
  await v1.getByLabel("SKU").fill(phone ? "PH-1" : "SH-M");
  if (!phone) await v1.getByLabel("Size").fill("M");
  await v1.getByLabel("Selling price (₹)").fill(phone ? "15000" : "799");
  await form.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByRole("heading", { name: phone ? "Phone" : "Cotton Shirt" })).toBeVisible();

  await page.goto("/inventory/opening");
  await page.getByLabel("SKU or barcode").fill(phone ? "PH-1" : "SH-M");
  await page.getByLabel("Quantity").fill(String(opts.quantity));
  await page.getByLabel("Cost per unit (₹)").fill(phone ? "12000" : "450");
  if (phone) await page.getByLabel("IMEI / serial numbers (IMEI items only, one per line)").fill((opts.imeis ?? []).join("\n"));
  await page.getByRole("button", { name: "Save opening stock" }).click();
  await expect(page.getByRole("status")).toHaveText("Opening stock saved (1 line).");
  return email;
}

// Registers this browser as a till and lets the service worker keep the
// till page and the Sync page (both visited once online).
export async function registerTill(page: Page, prefix: string): Promise<void> {
  await page.goto("/settings/tills");
  await page.getByLabel("Till name").fill(`Counter ${prefix}`);
  await page.getByLabel("Bill prefix (1-3 letters or digits)").fill(prefix);
  await page.getByRole("button", { name: "Register this computer" }).click();
  await expect(page.getByRole("status").filter({ hasText: "now the till" })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.goto("/sync");
  await expect(page.getByRole("heading", { name: "Sync status" })).toBeVisible();
  await page.goto("/pos");
  await expect(tillStatus(page)).toContainText(`Counter ${prefix} (${prefix})`);
}

export const tillStatus = (page: Page) => page.getByRole("status", { name: "Till status" });

// One bill at the offline till: scan, pay in cash, save; returns its number.
export async function sellOffline(page: Page, code: string, opts: { cash: string; imei?: string }): Promise<string> {
  await page.getByLabel("Scan a barcode, or type a SKU or name (F2)").fill(code);
  await page.getByLabel("Scan a barcode, or type a SKU or name (F2)").press("Enter");
  if (opts.imei !== undefined) await page.getByLabel(/^IMEI for /).fill(opts.imei);
  await page.getByLabel("Cash received (₹)").fill(opts.cash);
  await page.getByRole("button", { name: "Save bill offline (F9)" }).click();
  await expect(page.getByRole("status").filter({ hasText: "PENDING SYNC" })).toBeVisible();
  const heading = (await page.getByRole("heading", { name: /^Tax invoice / }).textContent()) ?? "";
  await page.getByRole("button", { name: "Next bill" }).click();
  return heading.replace("Tax invoice ", "").trim();
}

export async function waitForSync(page: Page): Promise<void> {
  // A whole number: "30 waiting to sync" also contains "0 waiting to sync".
  await expect(tillStatus(page)).toContainText(/(^|\D)0 waiting to sync/, { timeout: 60_000 });
  await expect(tillStatus(page)).not.toContainText("failed");
}

export async function newTillPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/pos");
  return page;
}
