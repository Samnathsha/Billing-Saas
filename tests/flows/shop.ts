import { expect, type Page } from "@playwright/test";
import { confirmedAccount, logIn } from "./helpers";

// A registered (GST) shop in Tamil Nadu with one product, Cotton Shirt M
// (SKU SH-M, ₹799, TEST 5%), and 5 in stock at ₹450. Returns the owner's
// email. `account` makes the owner's confirmed login (by email by default).
export async function shopWithStock(page: Page, account: (page: Page) => Promise<string> = (p) => confirmedAccount(p, "pos-owner")): Promise<string> {
  const email = await account(page);
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

export const stockOf = async (page: Page): Promise<string> => {
  await page.goto("/inventory");
  return (await page.getByRole("table", { name: "Stock levels" }).getByRole("row", { name: "Cotton Shirt M" }).getByRole("cell").nth(2).textContent()) ?? "";
};
