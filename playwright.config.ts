import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against a production build, as users will see it.
const PORT = 3100;

export default defineConfig({
  testDir: "tests/e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npx next start -p ${String(PORT)}`,
    url: `http://localhost:${String(PORT)}`,
    // The app's own address must match the test server, or the Origin check
    // (src/proxy.ts) would refuse the app's own requests. CI sets the same.
    env: { BETTER_AUTH_URL: `http://localhost:${String(PORT)}` },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
