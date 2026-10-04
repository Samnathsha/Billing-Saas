import { expect } from "@playwright/test";
import { test } from "./helpers";
import { shopWithStock, stockOf } from "./shop";

// Returns through the screens: one of two shirts back for cash, the printed
// credit note, stock back, and the bill can no longer be voided.

test("return one of two shirts for cash: credit note, stock back, no void afterwards", async ({ page }) => {
  test.slow();
  await shopWithStock(page);
  await page.goto("/pos");
  await page.getByLabel(/Scan a barcode/).fill("SH-M");
  await page.getByLabel(/Scan a barcode/).press("Enter");
  await page.getByLabel("Quantity of Cotton Shirt · M").fill("2");
  await page.getByLabel("Cash received (₹)").fill("1598");
  await page.getByRole("button", { name: /Save bill/ }).click();
  await expect(page.getByRole("heading", { name: "Tax Invoice" })).toBeVisible();
  const billUrl = page.url();
  expect(await stockOf(page)).toBe("3");

  await page.goto(billUrl);
  await page.getByRole("link", { name: "Return items" }).click();
  const row = page.getByRole("table", { name: "Returnable items" }).getByRole("row", { name: "Cotton Shirt · M" });
  await row.getByLabel("Return quantity of Cotton Shirt · M").fill("3");
  await page.getByLabel("Reason").fill("Wrong size");
  await page.getByRole("button", { name: "Save return" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "more than was sold" })).toBeVisible();
  // What was typed is still there after the refusal.
  await expect(page.getByLabel("Reason")).toHaveValue("Wrong size");
  await row.getByLabel("Return quantity of Cotton Shirt · M").fill("1");
  await page.getByRole("button", { name: "Save return" }).click();

  // Half the line: taxable 760.95, CGST = SGST 19.03; 799.01 -> round off -0.01 -> refund 799.00.
  await expect(page.getByRole("heading", { name: "Credit Note" })).toBeVisible();
  const note = page.getByRole("article", { name: "Credit note" });
  await expect(note).toContainText(/No\. CN\/\d{2}-\d{2}\/00001/);
  await expect(note).toContainText("Reason: Wrong size");
  const sums = page.getByLabel("Totals");
  await expect(sums).toContainText("Taxable value₹760.95");
  await expect(sums).toContainText("CGST₹19.03");
  await expect(sums).toContainText("Refund₹799.00");
  await expect(sums).toContainText("Paid back asCash");
  expect(await stockOf(page)).toBe("4");

  await page.goto(billUrl);
  await expect(page.getByRole("region", { name: "Returns" })).toContainText("₹799.00 refunded (Cash)");
  await expect(page.getByRole("button", { name: "Void bill" })).toHaveCount(0);
  await page.getByRole("link", { name: "Return items" }).click();
  await expect(page.getByRole("table", { name: "Returnable items" })).toContainText("1");
});

test("exchange: two shirts back, one out; the difference goes back in cash; the new bill is paid by the exchange", async ({ page }) => {
  test.slow();
  await shopWithStock(page);
  await page.goto("/pos");
  await page.getByLabel(/Scan a barcode/).fill("SH-M");
  await page.getByLabel(/Scan a barcode/).press("Enter");
  await page.getByLabel("Quantity of Cotton Shirt · M").fill("2");
  await page.getByLabel("Cash received (₹)").fill("1598");
  await page.getByRole("button", { name: /Save bill/ }).click();
  await expect(page.getByRole("heading", { name: "Tax Invoice" })).toBeVisible();

  await page.getByRole("link", { name: "Exchange" }).click();
  await page.getByLabel("Return quantity of Cotton Shirt · M").fill("2");
  await page.getByLabel("Scan or type the new item's SKU").fill("SH-M");
  await page.getByLabel("Scan or type the new item's SKU").press("Enter");
  await expect(page.getByLabel("New Cotton Shirt · M", { exact: true })).toBeVisible();
  const totals = page.getByLabel("Exchange totals");
  await expect(totals).toContainText("Value coming back₹1,598.00");
  await expect(totals).toContainText("New bill₹799.00");
  await expect(totals).toContainText("Customer pays₹0.00");
  await expect(totals).toContainText("Customer gets back₹799.00");
  await page.getByLabel("Reason").fill("Bought one too many");
  await page.getByRole("button", { name: "Save exchange" }).click();

  await expect(page.getByRole("heading", { name: "Tax Invoice" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Bill" })).toContainText(/No\. INV\/\d{2}-\d{2}\/00002/);
  await expect(page.getByLabel("Totals")).toContainText("Paid by Exchange (returned items)₹799.00");
  await expect(page.getByRole("button", { name: "Void bill" })).toHaveCount(0);
  // 5 - 2 sold + 2 back - 1 out
  expect(await stockOf(page)).toBe("4");
});
