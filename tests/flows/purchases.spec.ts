import { expect, type Page } from "@playwright/test";
import { confirmedAccount, formAlert, logIn, newDevice, test } from "./helpers";
import { addMember } from "./local-db";

// Phase 6 through the screens: opening stock, a supplier, a purchase with
// part payment, a refused duplicate bill, a void, an adjustment, and what a
// cashier may see.

async function registeredShopWithShirt(page: Page): Promise<string> {
  const email = await confirmedAccount(page, "buy-owner");
  await logIn(page, email);
  await page.getByLabel("Business name").fill("Purchase Shop");
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
  await form.getByLabel("Product name").fill("Cotton Shirt");
  await form.getByLabel("Unit").selectOption({ label: "Piece (pcs)" });
  await form.getByLabel("Tax rate").selectOption({ label: "TEST 5%" });
  const v1 = form.getByRole("group", { name: "Variant 1" });
  await v1.getByLabel("SKU").fill("SH-M");
  await v1.getByLabel("Size").fill("M");
  await v1.getByLabel("Selling price (₹)").fill("799");
  await form.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByRole("heading", { name: "Cotton Shirt" })).toBeVisible();
  return email;
}

const shirtRow = (page: Page) => page.getByRole("table", { name: "Stock levels" }).getByRole("row", { name: "Cotton Shirt M" });

test("opening stock, a purchase with part payment, a refused duplicate, a void and an adjustment", async ({ page, browser }) => {
  test.slow();
  const ownerEmail = await registeredShopWithShirt(page);

  // Opening stock: 2 shirts at ₹100.
  await page.getByRole("link", { name: "Stock" }).click();
  await page.getByRole("link", { name: "Opening stock" }).click();
  await page.getByLabel("SKU or barcode").fill("sh-m");
  await page.getByLabel("Quantity").fill("2");
  await page.getByLabel("Cost per unit (₹)").fill("100");
  await page.getByRole("button", { name: "Save opening stock" }).click();
  await expect(page.getByRole("status")).toHaveText("Opening stock saved (1 line).");
  await page.goto("/inventory");
  await expect(shirtRow(page)).toContainText("2");
  await expect(shirtRow(page)).toContainText("₹100.00");

  // A supplier.
  await page.getByRole("link", { name: "Suppliers" }).click();
  await page.getByLabel("Supplier name").fill("Ravi Traders");
  await page.getByRole("button", { name: "Add supplier" }).click();
  await expect(page.getByRole("heading", { name: "Ravi Traders" })).toBeVisible();
  await expect(page.getByLabel("Balance", { exact: true })).toHaveText("Settled");

  // A purchase: 10 shirts at ₹50 + 5% GST = ₹525; ₹200 paid now.
  await page.getByRole("link", { name: "New purchase from this supplier" }).click();
  await page.getByLabel("Supplier bill number").fill("RT/101");
  const line = page.getByRole("group", { name: "Line 1" });
  await line.getByLabel("SKU or barcode").fill("SH-M");
  await line.getByLabel("Quantity").fill("10");
  await line.getByLabel("Price per unit before GST (₹)").fill("50");
  await line.getByLabel("GST %").fill("5");
  await page.getByLabel("Amount (₹)").fill("200");
  await page.getByLabel("Method").selectOption("cash");
  await page.getByRole("button", { name: "Save purchase" }).click();
  await expect(page.getByRole("status")).toContainText("Purchase saved");
  const totals = page.getByRole("definition");
  await expect(page.getByLabel("Totals")).toContainText("Bill total₹525.00");
  await expect(page.getByLabel("Totals")).toContainText("Paid with the bill₹200.00");
  expect(await totals.count()).toBe(4);
  const purchaseUrl = page.url();

  await page.getByRole("link", { name: "Ravi Traders" }).click();
  await expect(page.getByLabel("Balance", { exact: true })).toHaveText("We owe ₹325.00");
  await page.goto("/inventory");
  // (2 x ₹100 + 10 x ₹50) / 12 = ₹58.33; GST is not cost for a registered business.
  await expect(shirtRow(page)).toContainText("12");
  await expect(shirtRow(page)).toContainText("₹58.33");

  // The same bill again is refused.
  await page.goto("/purchases/new");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Ravi Traders" });
  await page.getByLabel("Supplier bill number").fill("rt/101");
  await page.getByLabel("SKU or barcode").fill("SH-M");
  await page.getByLabel("Quantity").fill("1");
  await page.getByLabel("Price per unit before GST (₹)").fill("50");
  await page.getByLabel("GST %").fill("5");
  await page.getByRole("button", { name: "Save purchase" }).click();
  await expect(page.locator(formAlert)).toHaveText("This supplier bill number is already entered for this supplier.");

  // Void it: stock and the account go back; the ₹200 paid stays as an advance.
  await page.goto(purchaseUrl);
  await page.getByLabel("Reason").fill("Wrong price");
  // Without the tick the browser does not send the form: nothing is voided.
  await page.getByRole("button", { name: "Void purchase" }).click();
  expect(await page.getByLabel("I understand this cannot be undone").evaluate((el) => (el as HTMLInputElement).validity.valueMissing)).toBe(true);
  await expect(page.getByRole("heading", { name: "Bill RT/101", exact: true })).toBeVisible();
  await page.getByLabel("I understand this cannot be undone").check();
  await page.getByRole("button", { name: "Void purchase" }).click();
  await expect(page.getByRole("heading", { name: /Bill RT\/101 \(voided\)/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Void purchase" })).toHaveCount(0);
  await page.getByRole("link", { name: "Ravi Traders" }).click();
  await expect(page.getByLabel("Balance", { exact: true })).toHaveText("Advance ₹200.00");
  await page.goto("/inventory");
  await expect(shirtRow(page)).toContainText("2");
  await expect(shirtRow(page)).toContainText("₹100.00");

  // One shirt damaged.
  await page.getByRole("link", { name: "Adjust stock" }).click();
  await page.getByLabel("SKU or barcode").fill("SH-M");
  await page.getByLabel("Quantity").fill("1");
  await page.getByLabel("Reason").selectOption("damaged");
  await page.getByRole("button", { name: "Save adjustment" }).click();
  await expect(page.getByRole("status")).toHaveText("Adjustment saved.");
  await page.getByLabel("Quantity").fill("5");
  await page.getByLabel("SKU or barcode").fill("SH-M");
  await page.getByLabel("Reason").selectOption("lost");
  await page.getByRole("button", { name: "Save adjustment" }).click();
  await expect(page.locator(formAlert)).toHaveText("Not enough stock. (Cotton Shirt · M)");
  await page.goto("/inventory");
  await expect(shirtRow(page)).toContainText("1");

  // A cashier sees stock (no cost) but not purchases or suppliers.
  const till = await (await newDevice(browser)).newPage();
  const cashierEmail = await confirmedAccount(till, "buy-cashier");
  await addMember(ownerEmail, cashierEmail, "Cashier");
  await logIn(till, cashierEmail);
  await expect(till).toHaveURL(/\/dashboard$/);
  await till.getByRole("link", { name: "Stock" }).click();
  await expect(till.getByRole("row", { name: "Cotton Shirt M" })).toContainText("1");
  await expect(till.locator("main")).not.toContainText("Average cost");
  await expect(till.getByRole("link", { name: "Purchases" })).toHaveCount(0);
  await expect(till.getByRole("link", { name: "Adjust stock" })).toHaveCount(0);
  for (const path of ["/purchases", "/purchases/new", "/suppliers", "/inventory/adjust", "/inventory/opening", purchaseUrl]) {
    await till.goto(path);
    await expect(till.getByRole("heading", { name: "Not allowed" })).toBeVisible();
  }
});
