import { expect } from "@playwright/test";
import { confirmedAccount, logIn, newDevice, test } from "./helpers";
import { addMember } from "./local-db";

// Expenses through the screens: the usual categories, record, totals, void;
// an accountant sees them but cannot record.

test("record and void an expense; an accountant only looks", async ({ page, browser }) => {
  test.slow();
  const ownerEmail = await confirmedAccount(page, "exp-owner");
  await logIn(page, ownerEmail);
  await page.getByLabel("Business name").fill("Expense Shop");
  await page.getByRole("button", { name: "Create my business" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.getByRole("link", { name: "Expenses" }).click();
  await page.getByRole("button", { name: /Add the usual categories/ }).click();
  const form = page.getByRole("form", { name: "Record an expense" });
  await form.getByLabel("Category").selectOption({ label: "Rent" });
  await form.getByLabel("Amount (₹)").fill("15000");
  await form.getByLabel("Paid by").selectOption("bank");
  await form.getByLabel("What for").fill("October rent");
  await form.getByRole("button", { name: "Save expense" }).click();
  await expect(form.getByRole("status")).toHaveText("Expense saved.");
  const totals = page.getByLabel("Expense totals");
  await expect(totals).toContainText("₹15,000.00");
  await expect(totals).toContainText("Rent: ₹15,000.00");

  const row = page.getByRole("table", { name: "Expenses" }).getByRole("row", { name: "October rent" });
  await row.getByLabel("Reason to void October rent").fill("Entered twice");
  await row.getByRole("button", { name: "Void" }).click();
  await expect(page.getByRole("table", { name: "Expenses" })).toContainText("Voided: Entered twice");
  await expect(totals).toContainText("₹0.00");

  const other = await (await newDevice(browser)).newPage();
  const accountantEmail = await confirmedAccount(other, "exp-accountant");
  await addMember(ownerEmail, accountantEmail, "Accountant");
  await logIn(other, accountantEmail);
  await expect(other).toHaveURL(/\/dashboard$/);
  await other.getByRole("link", { name: "Expenses" }).click();
  await expect(other.getByRole("table", { name: "Expenses" })).toContainText("October rent");
  await expect(other.getByRole("form", { name: "Record an expense" })).toHaveCount(0);
  await expect(other.getByRole("button", { name: "Void" })).toHaveCount(0);
});
