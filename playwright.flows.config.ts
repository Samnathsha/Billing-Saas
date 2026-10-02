import { defineConfig, devices } from "@playwright/test";
import { LOCAL_APP_DB_URL, LOCAL_AUTH_DB_URL } from "./tests/flows/local-db";

// Full login flows in a real browser, against the LOCAL throwaway test
// database (docs/database-setup.md, port 55432). Never Neon, never real
// email: emails go to .dev-mailbox/, where the tests read the links.
//   npm run test:flows
const PORT = 3200;

export default defineConfig({
  testDir: "tests/flows",
  globalSetup: "./tests/flows/global-setup.ts",
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://localhost:${String(PORT)}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next dev -p ${String(PORT)}`,
    url: `http://localhost:${String(PORT)}`,
    reuseExistingServer: false,
    timeout: 180_000,
    // Set here, so they win over .env.local (Next.js never overrides
    // variables that are already set). No passwords: the local database
    // trusts local connections.
    env: {
      DATABASE_URL_DEV: LOCAL_APP_DB_URL,
      AUTH_DATABASE_URL_DEV: LOCAL_AUTH_DB_URL,
      BETTER_AUTH_URL: `http://localhost:${String(PORT)}`,
      RESEND_API_KEY: "",
      EMAIL_FROM: "",
    },
  },
});
