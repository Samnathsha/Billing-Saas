import { expect, test } from "@playwright/test";

// The proxy's Origin check (src/proxy.ts) on the real server: state-changing
// requests from another site, or without an Origin, are refused before any
// page, API route or login endpoint runs.

const EVIL = "https://evil.example";

test("writes from another site are refused on API routes, login endpoints and pages", async ({ request }) => {
  for (const path of ["/api/health", "/api/auth/sign-out", "/api/auth/sign-in/email", "/"]) {
    const response = await request.post(path, { headers: { Origin: EVIL }, data: {} });
    expect(response.status(), path).toBe(403);
    expect(await response.json()).toEqual({ message: "Request refused." });
  }
});

test("a write with no Origin header is refused", async ({ request }) => {
  const response = await request.post("/api/auth/sign-out", { data: {} });
  expect(response.status()).toBe(403);
});

test("reads from anywhere still work", async ({ request }) => {
  const response = await request.get("/api/health", { headers: { Origin: EVIL } });
  expect(response.status()).toBe(200);
});

// A write from our own origin passing through is shown by health.spec.ts
// (POST /api/health reaches the route and gets 405).
