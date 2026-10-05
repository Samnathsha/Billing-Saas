import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { expect } from "@playwright/test";
import { confirmedAccount, logIn, PASSWORD, test } from "./helpers";

// Two-step login in a real browser (Phase 11): switch it on with the QR
// code's key, log out, log in again with a code from the "app"; a wrong
// code is refused; a backup code works.

const codeFor = async (key: string): Promise<string> => createOTP(new TextDecoder().decode(base32.decode(key.replace(/\s+/g, "")))).totp();

test("switch on two-step login, then log in with the password and a code", async ({ page }) => {
  // Setup plus three logins (each with Argon2id): longer than the default.
  test.setTimeout(90_000);
  const email = await confirmedAccount(page, "two-step");
  await logIn(page, email);
  await page.getByLabel("Business name").fill("Two Step Shop");
  await page.getByRole("button", { name: "Create my business" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.getByRole("link", { name: "Two-step login" }).click();
  await page.getByLabel("Your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Set up two-step login" }).click();
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  const key = (await page.getByLabel("Setup key").textContent()) ?? "";
  await page.getByLabel("Code from your app").fill("000000");
  await page.getByRole("button", { name: "Turn on two-step login" }).click();
  await expect(page.getByText("That code is not right.")).toBeVisible();
  await page.getByLabel("Code from your app").fill(await codeFor(key));
  await page.getByRole("button", { name: "Turn on two-step login" }).click();
  await expect(page.getByRole("status")).toHaveText("Two-step login is on.");
  const backup = (await page.getByRole("list", { name: "Backup code list" }).getByRole("listitem").first().textContent()) ?? "";
  await page.getByRole("button", { name: "I have saved them" }).click();
  await expect(page.getByRole("status")).toContainText("Two-step login is on");

  // Log out; the password alone is not enough any more.
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await logIn(page, email);
  await expect(page.getByLabel("Code from your app")).toBeVisible();
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);

  await logIn(page, email);
  await page.getByLabel("Code from your app").fill("123456");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That code is not right." })).toBeVisible();
  await page.getByLabel("Code from your app").fill(await codeFor(key));
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // A backup code works too (once).
  await page.getByRole("button", { name: "Log out" }).click();
  await logIn(page, email);
  await page.getByRole("button", { name: "Use a backup code instead" }).click();
  await page.getByLabel("Backup code").fill(backup);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});
