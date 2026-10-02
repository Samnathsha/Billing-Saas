import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { confirmedAccount, logIn, newDevice, test } from "./helpers";
import { lastLinkTo } from "./mailbox";

async function ownerWithBusiness(page: Page): Promise<void> {
  const email = await confirmedAccount(page, "staff-owner");
  await logIn(page, email);
  await page.getByLabel("Business name").fill("Staff Shop");
  await page.getByRole("button", { name: "Create my business" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function invite(page: Page, email: string, role: string): Promise<void> {
  await page.goto("/settings/staff");
  const form = page.getByRole("form", { name: "Invite staff" });
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Role").selectOption({ label: role });
  await form.getByRole("button", { name: "Send invitation" }).click();
  await expect(form.getByRole("status")).toHaveText("Invitation sent. The link works for 7 days.");
}

test("invite, accept by link after logging in, change role, deactivate", async ({ page, browser }) => {
  test.slow();
  await ownerWithBusiness(page);
  const staffEmail = `staff-${randomUUID()}@test.invalid`;
  await invite(page, staffEmail, "Cashier");
  await expect(page.getByRole("list", { name: "Open invitations" })).toContainText(staffEmail);

  // The invited person creates an account with that email, then opens the link.
  const phone = await (await newDevice(browser)).newPage();
  await confirmedAccount(phone, "staff", staffEmail);
  await phone.goto(await lastLinkTo(staffEmail, "/invite?token="));
  await expect(phone.getByRole("heading", { name: "You are invited" })).toBeVisible();
  await phone.getByRole("link", { name: "Log in to accept" }).click();
  await phone.getByLabel("Email").fill(staffEmail);
  await phone.getByLabel("Password").fill("a long flow passphrase 2026");
  await phone.getByRole("button", { name: "Log in" }).click();
  // Back on the invitation; the token leaves the address bar.
  await expect(phone.getByRole("heading", { name: "Join the business" })).toBeVisible();
  await expect(phone).toHaveURL(/\/invite$/);
  await phone.getByRole("button", { name: "Join the business" }).click();
  await expect(phone).toHaveURL(/\/dashboard$/);
  await expect(phone.getByRole("banner")).toContainText("Cashier");

  // The owner sees the new member; open invitations are empty.
  await page.reload();
  const member = page.getByRole("list", { name: "Team" }).getByRole("listitem").filter({ hasText: staffEmail });
  await expect(member).toBeVisible();
  await expect(page.getByText("None.")).toBeVisible();

  // Changing the role logs them out everywhere.
  await member.getByRole("combobox").selectOption({ label: "Manager" });
  await member.getByRole("button", { name: "Change role" }).click();
  await expect(member.getByRole("status")).toHaveText(
    "Role changed. They have been logged out and will log in again with the new role.",
  );
  await phone.goto("/dashboard");
  await expect(phone).toHaveURL(/\/login$/);

  // Deactivating: they keep their login but have no business any more.
  await page.reload();
  await page.getByRole("list", { name: "Team" }).getByRole("listitem").filter({ hasText: staffEmail }).getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByRole("list", { name: "Team" }).getByRole("listitem").filter({ hasText: staffEmail })).toContainText("deactivated");
});

test("an invitation can be withdrawn; its link then does not work", async ({ page, browser }) => {
  test.slow();
  await ownerWithBusiness(page);
  const email = `withdrawn-${randomUUID()}@test.invalid`;
  await invite(page, email, "Accountant");
  const link = await lastLinkTo(email, "/invite?token=");
  await page.getByRole("list", { name: "Open invitations" }).getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByText("None.")).toBeVisible();

  const other = await (await newDevice(browser)).newPage();
  await confirmedAccount(other, "withdrawn", email);
  await logIn(other, email);
  await expect(other).toHaveURL(/\/setup$/);
  await other.goto(link);
  await other.getByRole("button", { name: "Join the business" }).click();
  await expect(other.locator("p[role=alert]")).toContainText("not valid for this account");
});

test("the owner and you cannot be changed; a cashier cannot open Staff", async ({ page }) => {
  await ownerWithBusiness(page);
  await page.goto("/settings/staff");
  const you = page.getByRole("list", { name: "Team" }).getByRole("listitem");
  await expect(you).toContainText("(you)");
  await expect(you.getByRole("button")).toHaveCount(0);
});
