import { expect, type Page } from "@playwright/test";
import { confirmedAccount, logIn, newDevice, test } from "./helpers";
import { addMember } from "./local-db";

async function ownerWithBusiness(page: Page): Promise<string> {
  const email = await confirmedAccount(page, "lists-owner");
  await logIn(page, email);
  await page.getByLabel("Business name").fill("Lists Shop");
  await page.getByRole("button", { name: "Create my business" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return email;
}

test("categories with a subcategory, a brand, a unit; duplicates refused; archive and restore", async ({ page }) => {
  test.slow();
  await ownerWithBusiness(page);
  await page.getByRole("link", { name: "Catalog" }).click();
  await expect(page.getByRole("heading", { name: "Catalog lists" })).toBeVisible();
  // Starting units.
  await expect(page.getByRole("list", { name: "Units" })).toContainText("pcs · whole only");

  const addCategory = page.getByRole("form", { name: "Add category" });
  await addCategory.getByLabel("Name").fill("Men");
  await addCategory.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("list", { name: "Categories" }).getByRole("listitem", { name: "Men" })).toBeVisible();
  await addCategory.getByLabel("Name").fill("Shirts");
  await addCategory.getByLabel("Inside (optional)").selectOption({ label: "Men" });
  await addCategory.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("list", { name: "Categories" }).getByRole("listitem", { name: "Shirts" })).toContainText("inside Men");

  const addBrand = page.getByRole("form", { name: "Add brand" });
  await addBrand.getByLabel("Name").fill("Raymond");
  await addBrand.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("list", { name: "Brands" }).getByRole("listitem", { name: "Raymond" })).toBeVisible();
  await addBrand.getByLabel("Name").fill("RAYMOND");
  await addBrand.getByRole("button", { name: "Add" }).click();
  await expect(addBrand.getByRole("alert")).toContainText("already used");

  const addUnit = page.getByRole("form", { name: "Add unit" });
  await addUnit.getByLabel("Name").fill("Dozen");
  await addUnit.getByLabel("Code").fill("dz");
  await addUnit.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("list", { name: "Units" }).getByRole("listitem", { name: "Dozen" })).toContainText("dz · whole only");

  const raymond = page.getByRole("list", { name: "Brands" }).getByRole("listitem", { name: "Raymond" });
  await raymond.getByRole("button", { name: "Archive" }).click();
  await expect(raymond).toContainText("(archived)");
  await raymond.getByRole("button", { name: "Restore" }).click();
  await expect(raymond.getByRole("button", { name: "Archive" })).toBeVisible();
});

test("a cashier gets no Catalog link and 'Not allowed'", async ({ page, browser }) => {
  const ownerEmail = await ownerWithBusiness(page);
  const till = await (await newDevice(browser)).newPage();
  const cashierEmail = await confirmedAccount(till, "lists-cashier");
  await addMember(ownerEmail, cashierEmail, "Cashier");
  await logIn(till, cashierEmail);
  await expect(till).toHaveURL(/\/dashboard$/);
  await expect(till.getByRole("link", { name: "Catalog" })).toHaveCount(0);
  await till.goto("/catalog/lists");
  await expect(till.getByRole("heading", { name: "Not allowed" })).toBeVisible();
});
