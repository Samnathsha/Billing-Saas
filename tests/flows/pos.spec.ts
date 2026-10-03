import { expect, type Page } from "@playwright/test";
import { confirmedAccount, logIn, newDevice, test } from "./helpers";
import { addMember } from "./local-db";

// Phase 7 through the screens: a bill at the till (scan, quantity, split
// payment), the printed bill's numbers, stock going down and back up on a
// same-day void, and what a cashier may do.

async function shopWithStock(page: Page): Promise<string> {
  const email = await confirmedAccount(page, "pos-owner");
  await logIn(page, email);
  await page.getByLabel("Business name").fill("Till Shop");
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

  await page.goto("/inventory/opening");
  await page.getByLabel("SKU or barcode").fill("SH-M");
  await page.getByLabel("Quantity").fill("5");
  await page.getByLabel("Cost per unit (₹)").fill("450");
  await page.getByRole("button", { name: "Save opening stock" }).click();
  await expect(page.getByRole("status")).toHaveText("Opening stock saved (1 line).");
  return email;
}

const stockOf = async (page: Page): Promise<string> => {
  await page.goto("/inventory");
  return (await page.getByRole("table", { name: "Stock levels" }).getByRole("row", { name: "Cotton Shirt M" }).getByRole("cell").nth(2).textContent()) ?? "";
};

test("a bill at the till, printed numbers, stock, a same-day void; a cashier sells but cannot void", async ({ page, browser }) => {
  test.slow();
  const ownerEmail = await shopWithStock(page);

  // Scan (a scanner types the code and presses Enter).
  await page.getByRole("link", { name: "New bill" }).click();
  await page.getByLabel(/Scan a barcode/).fill("sh-m");
  await page.getByLabel(/Scan a barcode/).press("Enter");
  const line = page.getByRole("table", { name: "Cart lines" }).getByRole("row", { name: "Cotton Shirt · M" });
  await expect(line).toBeVisible();
  await line.getByLabel("Quantity of Cotton Shirt · M").fill("2");
  const totals = page.getByLabel("Bill totals");
  await expect(totals).toContainText("To pay₹1,598.00");
  // Split: ₹1,000 cash received of which ₹598 kept... the rest by UPI.
  await page.getByLabel("UPI (₹)").fill("1000");
  await page.getByLabel("Cash received (₹)").fill("1000");
  await expect(page.getByLabel("Payment summary")).toContainText("Change to give₹402.00");
  await page.getByRole("button", { name: /Save bill/ }).click();

  // The printed bill. 159800 / 1.05 -> 152190; CGST = SGST = 3805.
  await expect(page.getByRole("heading", { name: "Tax Invoice" })).toBeVisible();
  const bill = page.getByRole("article", { name: "Bill" });
  await expect(bill).toContainText(/No\. INV\/\d{2}-\d{2}\/00001/);
  await expect(bill).toContainText("GSTIN: 33ABCDE1234F1Z7");
  await expect(bill).toContainText("12 Market Road, Chennai 600001");
  await expect(bill).toContainText("Place of supply: Tamil Nadu (33)");
  const sums = page.getByLabel("Totals");
  await expect(sums).toContainText("Taxable value₹1,521.90");
  await expect(sums).toContainText("CGST₹38.05");
  await expect(sums).toContainText("SGST₹38.05");
  await expect(sums).toContainText("Bill total₹1,598.00");
  await expect(sums).toContainText("Paid by Cash₹598.00");
  await expect(sums).toContainText("Paid by UPI₹1,000.00");
  const billUrl = page.url();
  expect(await stockOf(page)).toBe("3");

  // A cashier sells, but cannot void.
  const till = await (await newDevice(browser)).newPage();
  const cashierEmail = await confirmedAccount(till, "pos-cashier");
  await addMember(ownerEmail, cashierEmail, "Cashier");
  await logIn(till, cashierEmail);
  await expect(till).toHaveURL(/\/dashboard$/);
  await till.getByRole("link", { name: "New bill" }).click();
  await till.getByLabel(/Scan a barcode/).fill("SH-M");
  await till.getByLabel(/Scan a barcode/).press("Enter");
  // Over the cashier's 5% limit: refused on screen before saving.
  await till.getByLabel("Discount on Cotton Shirt · M").fill("50");
  await expect(till.getByRole("alert").filter({ hasText: "above your limit" })).toBeVisible();
  await expect(till.getByRole("button", { name: /Save bill/ })).toBeDisabled();
  await till.getByLabel("Discount on Cotton Shirt · M").fill("39");
  await till.getByLabel("Cash received (₹)").fill("760");
  await till.getByRole("button", { name: /Save bill/ }).click();
  await expect(till.getByRole("heading", { name: "Tax Invoice" })).toBeVisible();
  await expect(till.getByLabel("Totals")).toContainText("Bill total₹760.00");
  await expect(till.getByRole("button", { name: "Void bill" })).toHaveCount(0);
  await till.goto(billUrl);
  await expect(till.getByRole("button", { name: "Void bill" })).toHaveCount(0);
  expect(await stockOf(page)).toBe("2");

  // The owner voids the first bill: its 2 shirts come back.
  await page.goto(billUrl);
  await page.getByLabel("Reason").fill("Customer changed mind");
  await page.getByLabel("I understand this cannot be undone").check();
  await page.getByRole("button", { name: "Void bill" }).click();
  await expect(page.getByRole("article", { name: "Bill" })).toContainText("VOIDED: Customer changed mind");
  await expect(page.getByLabel("Totals")).toContainText("Refunded (UPI)₹1,000.00");
  expect(await stockOf(page)).toBe("4");
  await page.goto("/sales");
  await expect(page.getByText(/1 bill, ₹760\.00 \(1 voided, not counted\)/)).toBeVisible();
});

test("a customer with a credit limit buys partly on credit; the rest shows on their account", async ({ page }) => {
  test.slow();
  await shopWithStock(page);
  await page.getByRole("link", { name: "Customers" }).click();
  await page.getByLabel("Customer name").fill("Meena");
  await page.getByLabel("Phone").fill("98400 77777");
  await page.getByLabel("Credit limit (₹, 0 = no credit)").fill("1000");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("heading", { name: "Meena" })).toBeVisible();
  await expect(page.getByLabel("Credit", { exact: true })).toHaveText("Credit limit ₹1,000.00; ₹1,000.00 left.");

  await page.getByRole("link", { name: "New bill" }).click();
  await page.getByLabel(/Scan a barcode/).fill("SH-M");
  await page.getByLabel(/Scan a barcode/).press("Enter");
  await page.getByLabel("Customer (phone or name, optional)").fill("77777");
  await page.getByRole("button", { name: "Find" }).click();
  await page.getByRole("button", { name: /Meena/ }).click();
  await page.getByLabel("Cash received (₹)").fill("299");
  await expect(page.getByLabel("Payment summary")).toContainText("On the customer's account₹500.00");
  await page.getByRole("button", { name: /Save bill/ }).click();
  await expect(page.getByLabel("Totals")).toContainText("On account₹500.00");
  await expect(page.getByRole("article", { name: "Bill" })).toContainText("Bill to: Meena");

  await page.getByRole("link", { name: "Customers" }).click();
  await page.getByRole("link", { name: "Meena" }).click();
  await expect(page.getByLabel("Balance")).toHaveText("Owes ₹500.00");
  await expect(page.getByLabel("Credit", { exact: true })).toHaveText("Credit limit ₹1,000.00; ₹500.00 left.");

  // She pays ₹200 of it by UPI.
  const payment = page.getByRole("form", { name: "Take a payment" });
  await payment.getByLabel("Amount (₹)").fill("200");
  await payment.getByLabel("Method").selectOption("upi");
  await payment.getByLabel(/Reference/).fill("UTR 555");
  await payment.getByRole("button", { name: "Save payment" }).click();
  await expect(payment.getByRole("status")).toHaveText("Payment saved.");
  await expect(page.getByLabel("Balance")).toHaveText("Owes ₹300.00");
  await expect(page.getByRole("table", { name: "Customer payments" })).toContainText("UTR 555");

  // Over the limit: refused by the server, nothing saved.
  await page.getByRole("link", { name: "New bill" }).click();
  await page.getByLabel(/Scan a barcode/).fill("SH-M");
  await page.getByLabel(/Scan a barcode/).press("Enter");
  await page.getByLabel("Customer (phone or name, optional)").fill("Meena");
  await page.getByRole("button", { name: "Find" }).click();
  await page.getByRole("button", { name: /Meena/ }).click();
  await page.getByLabel("Cash received (₹)").fill("0");
  await page.getByRole("button", { name: /Save bill/ }).click();
  // 300 owed + 799 on credit > 1000.
  await expect(page.getByRole("alert").filter({ hasText: "over their credit limit" })).toBeVisible();
});
