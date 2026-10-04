import { expect } from "@playwright/test";
import { confirmedAccount, logIn, test } from "./helpers";

test("first login leads to business setup, then the dashboard; logout leaves the app", async ({ page }) => {
  const email = await confirmedAccount(page, "setup");
  await logIn(page, email);
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Set up your business" })).toBeVisible();

  await page.getByLabel("Business name").fill("Flow Textiles");
  await page.getByLabel("Mobile phone shop").check();
  await page.getByRole("button", { name: "Create my business" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  // The owner's dashboard shows today's figures.
  await expect(page.getByRole("heading", { name: /^Today, \d{4}-\d{2}-\d{2}$/ })).toBeVisible();
  await expect(page.getByRole("banner")).toContainText("Owner");

  // Setup is done: going back there leads to the dashboard.
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
});

test("without a login, app pages and setup lead to the login page", async ({ page }) => {
  for (const path of ["/", "/dashboard", "/setup"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/login$/);
  }
});

test("an empty business name is refused with a clear message", async ({ page }) => {
  const email = await confirmedAccount(page, "setup-empty");
  await logIn(page, email);
  await expect(page).toHaveURL(/\/setup$/);
  // Spaces only: passes the browser's "required" check, refused by the server.
  await page.getByLabel("Business name").fill("   ");
  await page.getByRole("button", { name: "Create my business" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("Please enter your business name");
  await expect(page).toHaveURL(/\/setup$/);
});
