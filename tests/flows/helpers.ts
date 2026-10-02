import { randomInt, randomUUID } from "node:crypto";
import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { lastLinkTo } from "./mailbox";

export const PASSWORD = "a long flow passphrase 2026";
// Our form messages (Next.js also has a hidden role="alert" route announcer).
export const formAlert = "p[role=alert]";

// Registers through the screens and confirms the email with the emailed link.
export async function confirmedAccount(page: Page, label = "flow"): Promise<string> {
  const email = `${label}-${randomUUID()}@test.invalid`;
  await page.goto("/register");
  await page.getByLabel("Your name").fill("Flow Person");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/Password/).fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");
  await page.goto(await lastLinkTo(email, "verify-email"));
  await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();
  return email;
}

export async function logIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}

// Each test (and each extra "device") is its own visitor with its own IP
// address, as real users are. Otherwise all tests share one address and the
// per-IP login limit (10 per minute) rightly stops them.
const randomIp = (): string => `10.${String(randomInt(256))}.${String(randomInt(256))}.${String(randomInt(1, 255))}`;

export const test = base.extend({
  // (Playwright's fixture callback, named so it is not taken for React's use.)
  extraHTTPHeaders: async ({}, provide) => {
    await provide({ "X-Forwarded-For": randomIp() });
  },
});

export function newDevice(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ extraHTTPHeaders: { "X-Forwarded-For": randomIp() } });
}
