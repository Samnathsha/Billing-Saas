import { expect, test } from "@playwright/test";

// The login screens render with their forms and no CSP violations. (Full
// flows with a database: tests/flows, `npm run test:flows`.)

for (const [path, heading, button] of [
  ["/register", "Create your account", "Create account"],
  ["/login", "Log in", "Log in"],
  ["/verify-email", "Email confirmed", null],
  ["/verify-email?error=invalid_token", "This link did not work", "Send the link again"],
] as const) {
  test(`${path} renders`, async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && m.text().includes("Content Security Policy")) violations.push(m.text());
    });
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    if (button !== null) await expect(page.getByRole("button", { name: button })).toBeVisible();
    expect(violations).toEqual([]);
  });
}

test("passwords are typed into password fields with the right autocomplete", async ({ page }) => {
  await page.goto("/register");
  const password = page.getByLabel(/Password/);
  await expect(password).toHaveAttribute("type", "password");
  await expect(password).toHaveAttribute("autocomplete", "new-password");
  await expect(password).toHaveAttribute("minlength", "12");
});

test("the token-revealing session endpoints are switched off", async ({ request }) => {
  for (const path of ["/api/auth/get-session", "/api/auth/list-sessions"]) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
});
