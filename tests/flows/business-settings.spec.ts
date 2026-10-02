import { expect, type Page } from "@playwright/test";
import { confirmedAccount, logIn, newDevice, test } from "./helpers";
import { addMember } from "./local-db";

// A made-up Tamil Nadu GSTIN with a correct check character.
const GSTIN = "33ABCDE1234F1Z7";

async function ownerWithBusiness(page: Page): Promise<string> {
  const email = await confirmedAccount(page, "settings-owner");
  await logIn(page, email);
  await page.getByLabel("Business name").fill("Settings Shop");
  await page.getByRole("button", { name: "Create my business" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return email;
}

test("the owner fills in the business and GST details; they are saved and shown again", async ({ page }) => {
  await ownerWithBusiness(page);
  await page.getByRole("link", { name: "Business settings" }).click();
  await expect(page.getByRole("heading", { name: "Business settings" })).toBeVisible();
  const plan = page.getByRole("region", { name: "Your plan" });
  await expect(plan).toContainText("Your plan: Pilot");
  await expect(plan).toContainText("Branches1 of 2");
  await expect(plan).toContainText("Staff (owner included)1 of 10");
  await expect(plan).toContainText("Tills0 of 5");

  await page.getByLabel("Business name").fill("Sharma Textiles");
  await page.getByLabel("Address", { exact: true }).fill("12 Market Road");
  await page.getByLabel("City").fill("Chennai");
  await page.getByLabel("State").selectOption("33");
  await page.getByLabel("PIN code").fill("600001");
  await page.getByLabel("Registered (regular)").check();
  // Typed the way people do: lower case with spaces.
  await page.getByLabel("GSTIN").fill("33abcde 1234f1z7");
  // The example number follows what is typed.
  await expect(page.getByText(/First number this year: INV\/\d{2}-\d{2}\/00001/)).toBeVisible();
  await page.getByLabel("Bill prefix").fill("shp");
  await expect(page.getByText(/First number this year: SHP\/\d{2}-\d{2}\/00001/)).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");

  await page.reload();
  await expect(page.getByLabel("Business name")).toHaveValue("Sharma Textiles");
  await expect(page.getByLabel("State")).toHaveValue("33");
  await expect(page.getByLabel("GSTIN")).toHaveValue(GSTIN);
  await expect(page.getByLabel("Registered (regular)")).toBeChecked();
  await expect(page.getByLabel("Bill prefix")).toHaveValue("SHP");
});

test("a mistyped GSTIN is refused next to the field, and nothing is saved", async ({ page }) => {
  await ownerWithBusiness(page);
  await page.goto("/settings/business");
  await page.getByLabel("State").selectOption("33");
  await page.getByLabel("Registered (regular)").check();
  await page.getByLabel("GSTIN").fill("33ABCDE1234F1Z8");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("p[role=alert]")).toHaveText("Please correct the marked fields.");
  await expect(page.getByText("This GSTIN is not valid. Check it for typing mistakes.")).toBeVisible();
  await expect(page.getByLabel("GSTIN")).toHaveAttribute("aria-invalid", "true");

  await page.reload();
  await expect(page.getByLabel("GSTIN")).toHaveValue("");
});

test("saving from an old page after someone else saved is refused", async ({ page, browser }) => {
  // The longest flow here (two devices, two saves): allow triple time.
  test.slow();
  const email = await ownerWithBusiness(page);
  await page.goto("/settings/business");

  const other = await newDevice(browser);
  const second = await other.newPage();
  await logIn(second, email);
  await expect(second).toHaveURL(/\/dashboard$/);
  await second.goto("/settings/business");
  await second.getByLabel("City").fill("Madurai");
  // A new business must say how it is registered for GST before saving.
  await second.getByLabel("Not registered").check();
  await second.getByRole("button", { name: "Save" }).click();
  await expect(second.getByRole("status")).toHaveText("Saved.");
  await other.close();

  await page.getByLabel("City").fill("Coimbatore");
  await page.getByLabel("Not registered").check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("Someone else changed these settings");
  await page.reload();
  await expect(page.getByLabel("City")).toHaveValue("Madurai");
});

test("a cashier gets no menu link and 'Not allowed' on the address", async ({ page, browser }) => {
  const ownerEmail = await ownerWithBusiness(page);
  const till = await (await newDevice(browser)).newPage();
  const cashierEmail = await confirmedAccount(till, "settings-cashier");
  await addMember(ownerEmail, cashierEmail, "Cashier");
  await logIn(till, cashierEmail);
  await expect(till).toHaveURL(/\/dashboard$/);
  await expect(till.getByRole("link", { name: "Business settings" })).toHaveCount(0);
  await till.goto("/settings/business");
  await expect(till.getByRole("heading", { name: "Not allowed" })).toBeVisible();
});
