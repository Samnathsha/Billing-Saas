import { expect, type Page } from "@playwright/test";
import { confirmedAccount, logIn, newDevice, test } from "./helpers";
import { addMember } from "./local-db";

// The Phase 8 hand test (docs/hand-tests/phase-8-hand-test.pdf), done by a
// browser exactly as written: setup, scenarios 1-14 and 16-20, final stock
// check. Scenario 15 needs a real 8-day gap (covered by
// tests/integration/returns.test.ts with a time-zone shift).

const shirt = "Test Shirt · M";

async function stock(page: Page, row: string): Promise<string> {
  await page.goto("/inventory");
  return (await page.getByRole("table", { name: "Stock levels" }).getByRole("row", { name: row }).getByRole("cell").nth(2).textContent()) ?? "";
}

async function sell(page: Page, sku: string, quantity: string, cash: string, customer?: string): Promise<string> {
  await page.goto("/pos");
  await page.getByLabel(/Scan a barcode/).fill(sku);
  await page.getByLabel(/Scan a barcode/).press("Enter");
  if (quantity !== "1") await page.getByLabel(`Quantity of ${shirt}`).fill(quantity);
  if (customer !== undefined) {
    await page.getByLabel("Customer (phone or name, optional)").fill(customer);
    await page.getByRole("button", { name: "Find" }).click();
    await page.getByRole("button", { name: new RegExp(customer) }).first().click();
  }
  if (cash !== "") await page.getByLabel("Cash received (₹)").fill(cash);
  await page.getByRole("button", { name: /Save bill/ }).click();
  await expect(page.getByRole("heading", { name: "Tax Invoice" })).toBeVisible();
  return page.url();
}

async function returnItems(page: Page, billUrl: string, quantity: string, reason: string, opts: { damaged?: boolean; method?: string } = {}): Promise<void> {
  await page.goto(billUrl);
  await page.getByRole("link", { name: "Return items" }).click();
  await page.getByLabel(`Return quantity of ${shirt}`).fill(quantity);
  if (opts.damaged === true) await page.getByLabel(`${shirt} can be sold again`).uncheck();
  if (opts.method !== undefined) await page.getByLabel("Money goes back as").selectOption(opts.method);
  await page.getByLabel("Reason").fill(reason);
  await page.getByRole("button", { name: "Save return" }).click();
  await expect(page.getByRole("heading", { name: "Credit Note" })).toBeVisible();
}

async function exchange(page: Page, billUrl: string, back: string, newSku: string, reason: string, cash?: string): Promise<string> {
  await page.goto(billUrl);
  await page.getByRole("link", { name: "Exchange" }).click();
  await page.getByLabel(`Return quantity of ${shirt}`).fill(back);
  await page.getByLabel("Scan or type the new item's SKU").fill(newSku);
  await page.getByLabel("Scan or type the new item's SKU").press("Enter");
  await expect(page.getByLabel(/^New /).first()).toBeVisible();
  if (cash !== undefined) await page.getByLabel("Cash received (₹)").fill(cash);
  await page.getByLabel("Reason").fill(reason);
  const totals = page.getByLabel("Exchange totals");
  const text = (await totals.textContent()) ?? "";
  await page.getByRole("button", { name: "Save exchange" }).click();
  await expect(page.getByRole("heading", { name: "Tax Invoice" })).toBeVisible();
  return text;
}

async function addCustomer(page: Page, name: string, phone: string): Promise<void> {
  await page.goto("/customers");
  await page.getByLabel("Customer name").fill(name);
  await page.getByLabel("Phone").fill(phone);
  await page.getByLabel("Credit limit (₹, 0 = no credit)").fill("2000");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function customerPage(page: Page, name: string): Promise<void> {
  await page.goto("/customers");
  await page.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function purchase(page: Page, bill: string, quantity: string, paid?: string): Promise<string> {
  await page.goto("/suppliers");
  await page.getByRole("link", { name: "Test Supplier" }).click();
  await page.getByRole("link", { name: "New purchase from this supplier" }).click();
  await page.getByLabel("Supplier bill number").fill(bill);
  const line = page.getByRole("group", { name: "Line 1" });
  await line.getByLabel("SKU or barcode").fill("TEST-799");
  await line.getByLabel("Quantity").fill(quantity);
  await line.getByLabel("Price per unit before GST (₹)").fill("50");
  await line.getByLabel("GST %").fill("5");
  if (paid !== undefined) {
    await page.getByLabel("Amount (₹)").fill(paid);
    await page.getByLabel("Method").selectOption("cash");
  }
  await page.getByRole("button", { name: "Save purchase" }).click();
  await expect(page.getByRole("status")).toContainText("Purchase saved");
  return page.url();
}

async function sendBack(page: Page, purchaseUrl: string, quantity: string, reason: string): Promise<void> {
  await page.goto(purchaseUrl);
  await page.getByRole("link", { name: "Return goods to the supplier" }).click();
  await page.getByLabel(`Quantity of ${shirt} going back`).fill(quantity);
  await page.getByLabel("Reason").fill(reason);
  await page.getByRole("button", { name: "Send back" }).click();
  await expect(page.getByRole("status")).toContainText("Goods sent back");
}

const supplierBalance = async (page: Page): Promise<string> => {
  await page.goto("/suppliers");
  await page.getByRole("link", { name: "Test Supplier" }).click();
  return (await page.getByLabel("Balance", { exact: true }).textContent()) ?? "";
};

test("Phase 8 hand test, all scenarios as written", async ({ page, browser }) => {
  test.setTimeout(600_000);

  // Setup: a registered shop with Test Shirt (₹799) x30 and Test Jacket (₹1,299) x10.
  const ownerEmail = await confirmedAccount(page, "p8-owner");
  await logIn(page, ownerEmail);
  await page.getByLabel("Business name").fill("Phase 8 Shop");
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
  for (const [name, sku, size, price] of [
    ["Test Shirt", "TEST-799", "M", "799"],
    ["Test Jacket", "TEST-1299", "L", "1299"],
  ] as const) {
    await page.goto("/catalog/products/new");
    const form = page.getByRole("form", { name: "New product" });
    await form.getByLabel("Product name").fill(name);
    await form.getByLabel("Unit").selectOption({ label: "Piece (pcs)" });
    await form.getByLabel("Tax rate").selectOption({ label: "TEST 5%" });
    const v1 = form.getByRole("group", { name: "Variant 1" });
    await v1.getByLabel("SKU").fill(sku);
    await v1.getByLabel("Size").fill(size);
    await v1.getByLabel("Selling price (₹)").fill(price);
    await form.getByRole("button", { name: "Save product" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  await page.goto("/inventory/opening");
  const line1 = page.getByRole("group", { name: "Line 1" });
  await line1.getByLabel("SKU or barcode").fill("TEST-799");
  await line1.getByLabel("Quantity").fill("30");
  await line1.getByLabel("Cost per unit (₹)").fill("400");
  await page.getByRole("button", { name: "Add a line" }).click();
  const line2 = page.getByRole("group", { name: "Line 2" });
  await line2.getByLabel("SKU or barcode").fill("TEST-1299");
  await line2.getByLabel("Quantity").fill("10");
  await line2.getByLabel("Cost per unit (₹)").fill("700");
  await page.getByRole("button", { name: "Save opening stock" }).click();
  await expect(page.getByRole("status")).toHaveText("Opening stock saved (2 lines).");
  expect(await stock(page, "Test Shirt M")).toBe("30");
  expect(await stock(page, "Test Jacket L")).toBe("10");

  // 1. Sell 2, return 1 for cash.
  const bill1 = await sell(page, "TEST-799", "2", "1598");
  await expect(page.getByLabel("Totals")).toContainText("Bill total₹1,598.00");
  await returnItems(page, bill1, "1", "Testing return");
  await expect(page.getByLabel("Totals")).toContainText("Refund₹799.00");
  await expect(page.getByLabel("Totals")).toContainText("Paid back asCash");
  expect(await stock(page, "Test Shirt M")).toBe("29");

  // 2. The other one.
  await returnItems(page, bill1, "1", "Testing return");
  await expect(page.getByLabel("Totals")).toContainText("Refund₹799.00");
  expect(await stock(page, "Test Shirt M")).toBe("30");

  // 3. A third cannot come back.
  await page.goto(bill1);
  await expect(page.getByRole("region", { name: "Returns" }).getByRole("link")).toHaveCount(2);
  await page.getByRole("link", { name: "Return items" }).click();
  await expect(page.getByText("Everything on this bill has already been returned.")).toBeVisible();

  // 4. Damaged.
  const bill4 = await sell(page, "TEST-799", "1", "799");
  await returnItems(page, bill4, "1", "Torn", { damaged: true });
  await expect(page.getByLabel("Totals")).toContainText("Refund₹799.00");
  await expect(page.getByRole("article", { name: "Credit note" })).toContainText("damaged");
  expect(await stock(page, "Test Shirt M")).toBe("29");

  // 5. On credit.
  await addCustomer(page, "Test Credit A", "90000 00001");
  await page.goto("/pos");
  await page.getByLabel(/Scan a barcode/).fill("TEST-799");
  await page.getByLabel(/Scan a barcode/).press("Enter");
  await page.getByLabel("Customer (phone or name, optional)").fill("00001");
  await page.getByRole("button", { name: "Find" }).click();
  await page.getByRole("button", { name: /Test Credit A/ }).click();
  await expect(page.getByLabel("Payment summary")).toContainText("On the customer's account₹799.00");
  await page.getByRole("button", { name: /Save bill/ }).click();
  await expect(page.getByLabel("Totals")).toContainText("On account₹799.00");
  await expect(page.getByRole("article", { name: "Bill" })).toContainText("Bill to: Test Credit A");
  await customerPage(page, "Test Credit A");
  await expect(page.getByLabel("Balance")).toHaveText("Owes ₹799.00");
  expect(await stock(page, "Test Shirt M")).toBe("28");

  // 6. Store credit.
  await customerPage(page, "Test Credit A");
  await page.getByRole("table", { name: "Customer bills" }).getByRole("link").first().click();
  await expect(page.getByRole("heading", { name: "Tax Invoice" })).toBeVisible();
  const bill5 = page.url();
  await returnItems(page, bill5, "1", "Testing store credit", { method: "store_credit" });
  await expect(page.getByLabel("Totals")).toContainText("Paid back asStore credit (customer's account)");
  await customerPage(page, "Test Credit A");
  await expect(page.getByLabel("Balance")).toHaveText("Owes nothing");
  expect(await stock(page, "Test Shirt M")).toBe("29");

  // 7. A payment when nothing is owed.
  await customerPage(page, "Test Credit A");
  const payment = page.getByRole("form", { name: "Take a payment" });
  await payment.getByLabel("Amount (₹)").fill("500");
  await payment.getByLabel("Method").selectOption("upi");
  await payment.getByLabel(/Reference/).fill("UPI test");
  await payment.getByRole("button", { name: "Save payment" }).click();
  await expect(payment.getByRole("status")).toHaveText("Payment saved.");
  await expect(page.getByLabel("Balance")).toHaveText("Advance ₹500.00");

  // 8. Part paid, part on credit.
  await addCustomer(page, "Test Credit B", "90000 00002");
  await page.goto("/pos");
  await page.getByLabel(/Scan a barcode/).fill("TEST-799");
  await page.getByLabel(/Scan a barcode/).press("Enter");
  await page.getByLabel(`Quantity of ${shirt}`).fill("2");
  await page.getByLabel("Customer (phone or name, optional)").fill("00002");
  await page.getByRole("button", { name: "Find" }).click();
  await page.getByRole("button", { name: /Test Credit B/ }).click();
  await page.getByLabel("Cash received (₹)").fill("1000");
  await expect(page.getByLabel("Payment summary")).toContainText("On the customer's account₹598.00");
  await page.getByRole("button", { name: /Save bill/ }).click();
  await expect(page.getByRole("heading", { name: "Tax Invoice" })).toBeVisible();
  await customerPage(page, "Test Credit B");
  await expect(page.getByLabel("Balance")).toHaveText("Owes ₹598.00");
  expect(await stock(page, "Test Shirt M")).toBe("27");

  // 9. Walk-in: no store credit.
  const bill9 = await sell(page, "TEST-799", "1", "799");
  await page.goto(bill9);
  await page.getByRole("link", { name: "Return items" }).click();
  await expect(page.locator('#refundMethod option[value="store_credit"]')).toHaveCount(0);
  await expect(page.locator("#refundMethod option")).toHaveText(["Cash", "UPI", "Card"]);
  await returnItems(page, bill9, "1", "Walk-in test");
  await expect(page.getByLabel("Totals")).toContainText("Refund₹799.00");
  expect(await stock(page, "Test Shirt M")).toBe("27");

  // 10. Same price swap.
  const bill10 = await sell(page, "TEST-799", "1", "799");
  const swap = await exchange(page, bill10, "1", "TEST-799", "Size swap");
  expect(swap).toContain("Value coming back₹799.00");
  expect(swap).toContain("New bill₹799.00");
  expect(swap).toContain("Customer pays₹0.00");
  expect(swap).toContain("Customer gets back₹0.00");
  await expect(page.getByLabel("Totals")).toContainText("Paid by Exchange (returned items)₹799.00");
  const exchangeBill10 = page.url();
  expect(await stock(page, "Test Shirt M")).toBe("26");

  // 11. Two back, one out.
  const bill11 = await sell(page, "TEST-799", "2", "1598");
  const twoForOne = await exchange(page, bill11, "2", "TEST-799", "Bought one too many");
  expect(twoForOne).toContain("Value coming back₹1,598.00");
  expect(twoForOne).toContain("Customer gets back₹799.00");
  await expect(page.getByLabel("Totals")).toContainText("Paid by Exchange (returned items)₹799.00");
  await page.goto(bill11);
  await expect(page.getByRole("region", { name: "Returns" })).toContainText("₹1,598.00: ₹799.00 exchanged for new items, ₹799.00 refunded (Cash)");
  expect(await stock(page, "Test Shirt M")).toBe("25");

  // 12. Swap for the dearer jacket.
  const bill12 = await sell(page, "TEST-799", "1", "799");
  const dearer = await exchange(page, bill12, "1", "TEST-1299", "Wants the jacket", "500");
  expect(dearer).toContain("New bill₹1,299.00");
  expect(dearer).toContain("Customer pays₹500.00");
  await expect(page.getByLabel("Totals")).toContainText("Paid by Exchange (returned items)₹799.00");
  await expect(page.getByLabel("Totals")).toContainText("Paid by Cash₹500.00");
  expect(await stock(page, "Test Shirt M")).toBe("25");
  expect(await stock(page, "Test Jacket L")).toBe("9");

  // 13-14. No void after a return, or for an exchange bill.
  await page.goto(bill1);
  await expect(page.getByRole("link", { name: "Return items" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Void bill" })).toHaveCount(0);
  await page.goto(exchangeBill10);
  await expect(page.getByRole("heading", { name: "Tax Invoice" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Void bill" })).toHaveCount(0);

  // 16. Buy 10, send 4 back.
  await page.goto("/suppliers");
  await page.getByLabel("Supplier name").fill("Test Supplier");
  await page.getByRole("button", { name: "Add supplier" }).click();
  await expect(page.getByRole("heading", { name: "Test Supplier" })).toBeVisible();
  const ts1 = await purchase(page, "TS/1", "10");
  await expect(page.getByLabel("Totals")).toContainText("Bill total₹525.00");
  await sendBack(page, ts1, "4", "Damaged in transit");
  await expect(page.getByRole("region", { name: "Returned to supplier" })).toContainText("₹210.00 · Damaged in transit");
  await expect(page.getByRole("button", { name: "Void purchase" })).toHaveCount(0);
  expect(await supplierBalance(page)).toBe("We owe ₹315.00");
  expect(await stock(page, "Test Shirt M")).toBe("31");

  // 17. The other 6.
  await sendBack(page, ts1, "6", "Not needed");
  expect(await supplierBalance(page)).toBe("Settled");
  await page.goto(ts1);
  await page.getByRole("link", { name: "Return goods to the supplier" }).click();
  await expect(page.getByText("Everything on this bill has already gone back.")).toBeVisible();
  expect(await stock(page, "Test Shirt M")).toBe("25");

  // 18. Paid, then sent back: the supplier owes us.
  const ts2 = await purchase(page, "TS/2", "2", "105");
  await expect(page.getByLabel("Totals")).toContainText("Bill total₹105.00");
  await expect(page.getByLabel("Totals")).toContainText("Paid with the bill₹105.00");
  await sendBack(page, ts2, "2", "Wrong colour");
  expect(await supplierBalance(page)).toBe("Advance ₹105.00");
  expect(await stock(page, "Test Shirt M")).toBe("25");

  // 19. Expenses.
  await page.goto("/expenses");
  await page.getByRole("button", { name: /Add the usual categories/ }).click();
  const form = page.getByRole("form", { name: "Record an expense" });
  await form.getByLabel("Category").selectOption({ label: "Rent" });
  await form.getByLabel("Amount (₹)").fill("15000");
  await form.getByLabel("Paid by").selectOption("bank");
  await form.getByLabel("What for").fill("October rent");
  await form.getByRole("button", { name: "Save expense" }).click();
  await expect(form.getByRole("status")).toHaveText("Expense saved.");
  const totals = page.getByLabel("Expense totals");
  await expect(totals).toContainText("Rent: ₹15,000.00");
  const rent = page.getByRole("table", { name: "Expenses" }).getByRole("row", { name: "October rent" });
  await rent.getByLabel("Reason to void October rent").fill("Entered twice");
  await rent.getByRole("button", { name: "Void" }).click();
  await expect(page.getByRole("table", { name: "Expenses" })).toContainText("Voided: Entered twice");
  await expect(totals).toContainText("₹0.00");

  // 20. An accountant only looks.
  const other = await (await newDevice(browser)).newPage();
  const accountantEmail = await confirmedAccount(other, "p8-accountant");
  await addMember(ownerEmail, accountantEmail, "Accountant");
  await logIn(other, accountantEmail);
  await expect(other).toHaveURL(/\/dashboard$/);
  await other.goto("/expenses");
  await expect(other.getByRole("table", { name: "Expenses" })).toContainText("October rent");
  await expect(other.getByRole("form", { name: "Record an expense" })).toHaveCount(0);
  await expect(other.getByRole("button", { name: "Void" })).toHaveCount(0);
  await other.goto(bill4);
  await expect(other.getByRole("heading", { name: "Tax Invoice" })).toBeVisible();
  await expect(other.getByRole("link", { name: "Return items" })).toHaveCount(0);
  await expect(other.getByRole("link", { name: "Exchange" })).toHaveCount(0);
  await other.goto(ts1);
  await expect(other.getByRole("link", { name: "Return goods to the supplier" })).toHaveCount(0);

  // Final check.
  expect(await stock(page, "Test Shirt M")).toBe("25");
  expect(await stock(page, "Test Jacket L")).toBe("9");
});
