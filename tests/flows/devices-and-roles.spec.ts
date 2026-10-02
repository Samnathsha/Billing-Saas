import { expect, type Page } from "@playwright/test";
import { confirmedAccount, logIn, newDevice, test } from "./helpers";
import { addMember } from "./local-db";

async function ownerWithBusiness(page: Page): Promise<string> {
  const email = await confirmedAccount(page, "owner");
  await logIn(page, email);
  await page.getByLabel("Business name").fill("Devices Shop");
  await page.getByRole("button", { name: "Create my business" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return email;
}

const devices = (page: Page) => page.getByRole("list", { name: "Logged-in devices" }).getByRole("listitem");

test("your devices: see both, end the other one, it is logged out at once", async ({ page, browser }) => {
  const email = await ownerWithBusiness(page);
  const phoneContext = await newDevice(browser);
  const phone = await phoneContext.newPage();
  await logIn(phone, email);
  await expect(phone).toHaveURL(/\/dashboard$/);

  await page.getByRole("link", { name: "Your devices" }).click();
  await expect(devices(page)).toHaveCount(2);
  await expect(devices(page).filter({ hasText: "This device" })).toHaveCount(1);
  await devices(page).filter({ hasText: "Another device" }).getByRole("button", { name: "End" }).click();
  await expect(devices(page)).toHaveCount(1);

  await phone.goto("/dashboard");
  await expect(phone).toHaveURL(/\/login$/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
  await phoneContext.close();
});

test("log out everywhere ends every device, this one included", async ({ page, browser }) => {
  const email = await ownerWithBusiness(page);
  const tabletContext = await newDevice(browser);
  const tablet = await tabletContext.newPage();
  await logIn(tablet, email);
  await expect(tablet).toHaveURL(/\/dashboard$/);

  await page.goto("/settings/devices");
  await page.getByRole("button", { name: "Log out everywhere" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await tablet.goto("/dashboard");
  await expect(tablet).toHaveURL(/\/login$/);
  await tabletContext.close();
});

test("a cashier is not allowed on the owner's staff page, even by typing the address", async ({ page, browser }) => {
  const ownerEmail = await ownerWithBusiness(page);
  await page.goto("/settings/staff");
  await expect(page.getByRole("heading", { name: "Staff" })).toBeVisible();

  const cashierContext = await newDevice(browser);
  const till = await cashierContext.newPage();
  const cashierEmail = await confirmedAccount(till, "cashier");
  await addMember(ownerEmail, cashierEmail, "Cashier");
  await logIn(till, cashierEmail);
  await expect(till).toHaveURL(/\/dashboard$/);
  await expect(till.getByRole("banner")).toContainText("Cashier");
  await expect(till.getByRole("link", { name: "Staff" })).toHaveCount(0);

  await till.goto("/settings/staff");
  await expect(till.getByRole("heading", { name: "Not allowed" })).toBeVisible();
  await expect(till.getByRole("heading", { name: "Staff" })).toHaveCount(0);
  await cashierContext.close();
});
