import { expect, type Page } from "@playwright/test";
import { confirmedAccount, logIn, newDevice, test } from "./helpers";
import { addMember } from "./local-db";

async function ownerWithBusiness(page: Page): Promise<string> {
  const email = await confirmedAccount(page, "prod-owner");
  await logIn(page, email);
  await page.getByLabel("Business name").fill("Product Shop");
  await page.getByRole("button", { name: "Create my business" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return email;
}

test("create a product with two variants, change a price; a cashier never sees the cost", async ({ page, browser }) => {
  test.slow();
  const ownerEmail = await ownerWithBusiness(page);
  await page.getByRole("link", { name: "Products" }).click();
  await page.getByRole("link", { name: "New product" }).click();
  const form = page.getByRole("form", { name: "New product" });
  await form.getByLabel("Product name").fill("Cotton Shirt");
  await form.getByLabel("Unit").selectOption({ label: "Piece (pcs)" });
  await form.getByLabel("Tax rate").selectOption({ label: "TEST 5%" });
  const v1 = form.getByRole("group", { name: "Variant 1" });
  await v1.getByLabel("SKU").fill("SH-M");
  await v1.getByLabel("Size").fill("M");
  await v1.getByLabel("Selling price (₹)").fill("799.50");
  await v1.getByLabel("Cost (₹, optional)").fill("450");
  await form.getByRole("button", { name: "Add another variant" }).click();
  const v2 = form.getByRole("group", { name: "Variant 2" });
  await v2.getByLabel("SKU").fill("SH-L");
  await v2.getByLabel("Size").fill("L");
  await v2.getByLabel("Selling price (₹)").fill("849");
  await form.getByRole("button", { name: "Save product" }).click();

  await expect(page.getByRole("heading", { name: "Cotton Shirt" })).toBeVisible();
  const m = page.getByRole("list", { name: "Variants" }).getByRole("listitem", { name: "SH-M" });
  await expect(m).toContainText("₹799.50");
  await expect(m).toContainText("cost ₹450.00");
  await m.getByLabel("Price ₹").fill("749");
  await m.getByRole("button", { name: "Save prices" }).click();
  await expect(page.getByRole("list", { name: "Variants" }).getByRole("listitem", { name: "SH-M" })).toContainText("₹749.00");
  const url = page.url();

  const till = await (await newDevice(browser)).newPage();
  const cashierEmail = await confirmedAccount(till, "prod-cashier");
  await addMember(ownerEmail, cashierEmail, "Cashier");
  await logIn(till, cashierEmail);
  await expect(till).toHaveURL(/\/dashboard$/);
  await till.goto(url);
  await expect(till.getByRole("heading", { name: "Cotton Shirt" })).toBeVisible();
  await expect(till.locator("main")).not.toContainText("cost");
  await expect(till.getByRole("button", { name: "Save prices" })).toHaveCount(0);
  const html = await till.content();
  expect(html).not.toContain("45000");
  expect(html).not.toContain("costPricePaise");
});

test("add a barcode; scanning it in search opens exactly that item; name search lists matches", async ({ page }) => {
  test.slow();
  await ownerWithBusiness(page);
  await page.goto("/catalog/products/new");
  const form = page.getByRole("form", { name: "New product" });
  await form.getByLabel("Product name").fill("Denim Jeans");
  await form.getByLabel("Unit").selectOption({ label: "Piece (pcs)" });
  await form.getByLabel("Tax rate").selectOption({ label: "TEST 5%" });
  const v1 = form.getByRole("group", { name: "Variant 1" });
  await v1.getByLabel("SKU").fill("DN-32");
  await v1.getByLabel("Selling price (₹)").fill("1299");
  await form.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByRole("heading", { name: "Denim Jeans" })).toBeVisible();
  const item = page.getByRole("list", { name: "Variants" }).getByRole("listitem", { name: "DN-32" });
  await item.getByLabel("New barcode").fill("8901111222233");
  await item.getByRole("button", { name: "Add", exact: true }).click();
  await expect(item.getByText("8901111222233")).toBeVisible();

  await page.goto("/catalog/products");
  await page.getByLabel("Search products").fill("8901111222233");
  await page.getByLabel("Search products").press("Enter");
  await expect(page.getByRole("heading", { name: "Denim Jeans" })).toBeVisible();

  await page.goto("/catalog/products?q=denim");
  await expect(page.getByRole("list", { name: "Products" }).getByRole("listitem")).toHaveCount(1);
});
