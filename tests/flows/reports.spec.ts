import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { confirmedAccount, logIn, newDevice, test } from "./helpers";
import { addMember } from "./local-db";
import { shopWithStock } from "./shop";

// Phase 9 through the screens: the dashboard after a sale, the sales and
// profit reports, a CSV download (and its limit), and a cashier kept out of
// reports, profit and downloads even by typing the address.

test("dashboard, reports and CSV; a cashier cannot reach them", async ({ page, browser }) => {
  test.slow();
  const ownerEmail = await shopWithStock(page);
  // 2 shirts at ₹799 (cost ₹450 each): taxable 1,521.90, cost 900, gross profit 621.90.
  await page.goto("/pos");
  await page.getByLabel(/Scan a barcode/).fill("SH-M");
  await page.getByLabel(/Scan a barcode/).press("Enter");
  await page.getByLabel("Quantity of Cotton Shirt · M").fill("2");
  await page.getByLabel("Cash received (₹)").fill("1598");
  await page.getByRole("button", { name: /Save bill/ }).click();
  await expect(page.getByRole("heading", { name: "Tax Invoice" })).toBeVisible();

  await page.getByRole("link", { name: "Billing" }).click();
  const today = page.getByRole("region", { name: "Today" });
  await expect(today).toContainText("Net sales₹1,598.00");
  await expect(today).toContainText("1 bill");
  await expect(page.getByRole("region", { name: "Payments by method" })).toContainText("Cash₹1,598.00");

  await page.getByRole("link", { name: "Reports", exact: true }).first().click();
  await expect(page.getByLabel("Sales totals")).toContainText("Net sales₹1,598.00");
  await page.getByRole("link", { name: "Profit" }).click();
  await expect(page.getByLabel("Profit")).toContainText("Gross profit₹621.90");

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download CSV" }).click();
  const file = await (await download).path();
  const csv = await readFile(file, "utf8");
  expect(csv).toContain('"Gross profit","621.90"');

  // At most 10 downloads a minute (the one above counts).
  const statuses: number[] = [];
  for (let i = 0; i < 10; i += 1) statuses.push((await page.request.get("/api/reports/csv?report=stock")).status());
  expect(statuses.slice(0, 9).every((s) => s === 200)).toBe(true);
  expect(statuses[9]).toBe(429);

  const till = await (await newDevice(browser)).newPage();
  const cashierEmail = await confirmedAccount(till, "rep-cashier");
  await addMember(ownerEmail, cashierEmail, "Cashier");
  await logIn(till, cashierEmail);
  await expect(till).toHaveURL(/\/dashboard$/);
  await expect(till.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await expect(till.getByRole("link", { name: "Reports" })).toHaveCount(0);
  await till.goto("/reports?view=profit");
  await expect(till.getByRole("heading", { name: "Not allowed" })).toBeVisible();
  await till.goto("/reports/audit");
  await expect(till.getByRole("heading", { name: "Not allowed" })).toBeVisible();
  expect((await till.request.get("/api/reports/csv?report=profit&from=2026-01-01&to=2026-01-31")).status()).toBe(403);
  expect((await till.request.get("/api/reports/csv?report=sales&from=2026-01-01&to=2026-01-31")).status()).toBe(403);
});
