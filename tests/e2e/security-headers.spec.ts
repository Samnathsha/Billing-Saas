import { expect, test, type Page } from "@playwright/test";

// Collects CSP violations reported by the browser on this page.
async function watchCspViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const store: string[] = [];
    Object.assign(window, { __cspViolations: store });
    document.addEventListener("securitypolicyviolation", (event) => {
      store.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return () => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

test("pages send every security header", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  const headers = response?.headers() ?? {};

  expect(headers["strict-transport-security"]).toContain("max-age=63072000");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["permissions-policy"]).toContain("camera=()");
  expect(headers["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["content-security-policy"]).not.toContain("unsafe-eval");
  expect(headers["x-powered-by"]).toBeUndefined();
});

test("the nonce is new on every request", async ({ request }) => {
  const nonceOf = async () => {
    const csp = (await request.get("/")).headers()["content-security-policy"] ?? "";
    return /'nonce-([^']+)'/.exec(csp)?.[1];
  };
  const first = await nonceOf();
  const second = await nonceOf();
  expect(first).toBeTruthy();
  expect(first).not.toBe(second);
});

test("the page loads with no CSP violations, and Next.js scripts carry the nonce", async ({ page }) => {
  const violations = await watchCspViolations(page);
  const response = await page.goto("/");
  await page.waitForLoadState("networkidle");

  expect(await violations()).toEqual([]);

  const nonce = /'nonce-([^']+)'/.exec(response?.headers()["content-security-policy"] ?? "")?.[1];
  const scriptNonces = await page.locator("script").evaluateAll((scripts) =>
    scripts.map((s) => (s as HTMLScriptElement).nonce),
  );
  expect(scriptNonces.length).toBeGreaterThan(0);
  for (const scriptNonce of scriptNonces) expect(scriptNonce).toBe(nonce);
});

// Simulates stored XSS: attacker text (e.g. a customer name) ends up in the
// server's HTML. The real CSP header is kept; only the body is changed.
test("scripts injected into the page HTML are blocked", async ({ page }) => {
  const violations = await watchCspViolations(page);
  await page.route("/", async (route) => {
    const response = await route.fetch();
    const html = (await response.text()).replace(
      "<body",
      '<script>window.__injected = "inline"</script>' +
        '<img src="x" onerror="window.__injected = \'handler\'">' +
        "<body",
    );
    await route.fulfill({ response, body: html });
  });

  await page.goto("/");
  await page.waitForLoadState("networkidle");

  expect(await page.evaluate(() => (window as unknown as { __injected?: string }).__injected)).toBeUndefined();
  expect((await violations()).filter((v) => v.startsWith("script-src")).length).toBeGreaterThanOrEqual(2);
});

test("API routes get a strict CSP and the same headers", async ({ request }) => {
  const headers = (await request.get("/api/does-not-exist")).headers();
  expect(headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["strict-transport-security"]).toContain("max-age=");
});

test("static files get the fixed headers", async ({ request }) => {
  const headers = (await request.get("/favicon.ico")).headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
});
