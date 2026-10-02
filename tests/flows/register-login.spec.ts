import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./helpers";
import { lastLinkTo } from "./mailbox";

const PASSWORD = "a long flow passphrase 2026";
// Our form messages (Next.js also has a hidden role="alert" route announcer).
const formAlert = "p[role=alert]";

test("register, confirm the email, log in; scripts cannot see the session", async ({ page, context }) => {
  const email = `flow-${randomUUID()}@test.invalid`;

  await page.goto("/register");
  await page.getByLabel("Your name").fill("Flow Owner");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/Password/).fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");

  // Logging in before confirming is refused, with a way to resend the link.
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator(formAlert)).toContainText("confirm your email");
  await expect(page.getByRole("button", { name: "Send the link again" })).toBeVisible();

  await page.goto(await lastLinkTo(email, "verify-email"));
  await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/setup$/); // logged in; no business yet

  const cookie = (await context.cookies()).find((c) => c.name === "billing.session_token");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
  expect(await page.evaluate(() => document.cookie)).not.toContain("session_token");
  const status = await page.evaluate(async () => (await fetch("/api/auth/get-session")).status);
  expect(status).toBe(404);
});

test("a wrong password and an unknown email get the same message", async ({ page }) => {
  const messages: string[] = [];
  for (const email of [`nobody-${randomUUID()}@test.invalid`, `other-${randomUUID()}@test.invalid`]) {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("a wrong long password 1");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.locator(formAlert)).toBeVisible();
    messages.push(await page.locator(formAlert).innerText());
  }
  expect(messages[0]).toBe("Wrong email or password.");
  expect(messages[1]).toBe(messages[0]);
});

test("a bad confirmation link offers a new one", async ({ page }) => {
  await page.goto("/verify-email?error=invalid_token");
  await expect(page.getByRole("heading", { name: "This link did not work" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send the link again" })).toBeVisible();
});
