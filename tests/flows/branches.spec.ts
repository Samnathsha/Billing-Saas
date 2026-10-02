import { expect, type Page } from "@playwright/test";
import { confirmedAccount, logIn, newDevice, test } from "./helpers";
import { addMember } from "./local-db";

async function ownerWithBusiness(page: Page): Promise<string> {
  const email = await confirmedAccount(page, "branch-owner");
  await logIn(page, email);
  await page.getByLabel("Business name").fill("Branch Shop");
  await page.getByRole("button", { name: "Create my business" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return email;
}

const item = (page: Page, name: string) => page.getByRole("list", { name: "Branches" }).getByRole("listitem", { name });

test("add, hit the plan limit, close, keep the last one open, reopen, rename", async ({ page }) => {
  test.slow();
  await ownerWithBusiness(page);
  await page.getByRole("link", { name: "Branches" }).click();
  await expect(page.getByRole("heading", { name: "Branches" })).toBeVisible();
  await expect(item(page, "Main branch")).toBeVisible();

  await page.getByLabel("New branch name").fill("Anna Nagar");
  await page.getByRole("button", { name: "Add branch" }).click();
  await expect(item(page, "Anna Nagar")).toBeVisible();

  // The pilot plan allows 2.
  await page.getByLabel("New branch name").fill("T Nagar");
  await page.getByRole("button", { name: "Add branch" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Your plan allows 2 branches" })).toBeVisible();

  await item(page, "Anna Nagar").getByRole("button", { name: "Close branch" }).click();
  await expect(item(page, "Anna Nagar").getByRole("button", { name: "Reopen" })).toBeVisible();

  await item(page, "Main branch").getByRole("button", { name: "Close branch" }).click();
  await expect(item(page, "Main branch").getByRole("alert")).toHaveText("This is the only open branch. Open or add another branch first.");

  await item(page, "Anna Nagar").getByRole("button", { name: "Reopen" }).click();
  await expect(item(page, "Anna Nagar").getByRole("button", { name: "Close branch" })).toBeVisible();

  await item(page, "Main branch").getByLabel("Name of Main branch").fill("Head office");
  await item(page, "Main branch").getByRole("button", { name: "Rename" }).click();
  await expect(item(page, "Head office")).toBeVisible();
});

test("a cashier gets no Branches link and 'Not allowed' on the address", async ({ page, browser }) => {
  const ownerEmail = await ownerWithBusiness(page);
  const till = await (await newDevice(browser)).newPage();
  const cashierEmail = await confirmedAccount(till, "branch-cashier");
  await addMember(ownerEmail, cashierEmail, "Cashier");
  await logIn(till, cashierEmail);
  await expect(till).toHaveURL(/\/dashboard$/);
  await expect(till.getByRole("link", { name: "Branches" })).toHaveCount(0);
  await till.goto("/settings/branches");
  await expect(till.getByRole("heading", { name: "Not allowed" })).toBeVisible();
});
