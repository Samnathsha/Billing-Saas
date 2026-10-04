import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { confirmedAccount, logIn, newDevice, test } from "./helpers";
import { addMember } from "./local-db";

// The owner's own data (Phase 11): download everything as a ZIP; ask for
// the business to be deleted (a banner for everyone), then cancel. An admin
// does not get these controls.

test("the owner downloads all data and can ask for (and cancel) deletion; an admin cannot", async ({ page, browser }) => {
  const owner = await confirmedAccount(page, "data-owner");
  await logIn(page, owner);
  await page.getByLabel("Business name").fill("Data Shop");
  await page.getByRole("button", { name: "Create my business" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto("/settings/business");
  const section = page.getByRole("region", { name: "Your business's data" });
  const download = page.waitForEvent("download");
  await section.getByRole("link", { name: "Download all data (ZIP)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^business-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const bytes = await readFile((await file.path()) ?? "");
  expect(bytes.subarray(0, 2).toString()).toBe("PK");

  await section.getByLabel(/Type the business name/).fill("Data shop");
  await section.getByRole("button", { name: "Ask to delete this business" }).click();
  await expect(section.getByRole("alert").or(section.getByRole("status"))).toContainText("Type the business name exactly");
  await section.getByLabel(/Type the business name/).fill("Data Shop");
  await section.getByRole("button", { name: "Ask to delete this business" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This business will be deleted on" })).toBeVisible();

  // An admin sees the banner but has no controls.
  const adminEmail = await confirmedAccount(page, "data-admin");
  await addMember(owner, adminEmail, "Admin");
  const other = await newDevice(browser);
  const admin = await other.newPage();
  await logIn(admin, adminEmail);
  await expect(admin).toHaveURL(/\/dashboard$/);
  await expect(admin.getByRole("alert").filter({ hasText: "This business will be deleted on" })).toBeVisible();
  await admin.goto("/settings/business");
  await expect(admin.getByRole("region", { name: "Your business's data" })).toHaveCount(0);
  expect((await admin.request.get("/api/business/export")).status()).toBe(403);
  await other.close();

  await page.goto("/settings/business");
  await page.getByRole("button", { name: "Cancel the deletion" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This business will be deleted on" })).toHaveCount(0);
});
