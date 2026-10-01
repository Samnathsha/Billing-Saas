import { expect, test } from "@playwright/test";

test("GET /api/health returns only the status", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.text()).toBe('{"status":"ok"}');

  const headers = response.headers();
  expect(headers["content-type"]).toContain("application/json");
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-powered-by"]).toBeUndefined();
});

test("other methods are refused", async ({ request }) => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await request.fetch("/api/health", { method });
    expect(response.status(), method).toBe(405);
  }
});
