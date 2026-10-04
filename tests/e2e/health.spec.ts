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

test("other methods are refused", async ({ request, baseURL }) => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    // From our own origin: the route itself refuses the method.
    const response = await request.fetch("/api/health", { method, headers: { Origin: baseURL ?? "" } });
    expect(response.status(), method).toBe(405);
  }
});

// Phase 11: the nightly maintenance route exists only with CRON_SECRET set
// (not in this test build), and never without the key.
test("the maintenance route is off without its key", async ({ request }) => {
  expect((await request.get("/api/maintenance/compact")).status()).toBe(404);
  expect((await request.get("/api/maintenance/compact", { headers: { Authorization: "Bearer guess" } })).status()).toBe(404);
});
