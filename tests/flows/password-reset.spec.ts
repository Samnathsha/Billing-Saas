import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import pg from "pg";
import { LOCAL_AUTH_DB_URL } from "./local-db";
import { confirmedAccount, formAlert, logIn, newDevice, PASSWORD as OLD, test } from "./helpers";
import { lastLinkTo } from "./mailbox";

const NEW = "a brand new flow passphrase 9";

async function sessionCount(email: string): Promise<number> {
  const client = new pg.Client({ connectionString: LOCAL_AUTH_DB_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1",
      [email],
    );
    return rows[0]?.n ?? 0;
  } finally {
    await client.end();
  }
}

test("forgot password: link by email, new password works, old one does not, link works once", async ({ page, browser }) => {
  const email = await confirmedAccount(page, "reset");

  // Another device is logged in with the old password.
  const phone = await newDevice(browser);
  await logIn(await phone.newPage(), email, OLD);
  await expect.poll(() => sessionCount(email)).toBe(1);

  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot your password?" }).click();
  await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText("If this address has an account");

  const link = await lastLinkTo(email, "reset-password");
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  // The token is taken out of the address bar.
  await expect(page).toHaveURL(/\/reset-password$/);
  await page.getByLabel(/New password/).fill(NEW);
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByRole("status")).toContainText("Your password has been changed");
  // ...and is logged out: no session survives the reset.
  expect(await sessionCount(email)).toBe(0);
  await phone.close();

  await logIn(page, email, OLD);
  await expect(page.locator(formAlert)).toHaveText("Wrong email or password.");
  await logIn(page, email, NEW);
  await expect(page).toHaveURL(/\/setup$/); // logged in; no business yet

  // The same link a second time: refused, with a way to get a new one.
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "This link did not work" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send a new link" })).toBeVisible();
});

test("forgot password answers the same for an unknown address", async ({ page }) => {
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill(`nobody-${randomUUID()}@test.invalid`);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "If this address has an account, we have sent a link to reset the password (valid for 1 hour).",
  );
});
