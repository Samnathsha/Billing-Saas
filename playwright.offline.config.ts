import { defineConfig, devices } from "@playwright/test";
import { LOCAL_APP_DB_URL, LOCAL_AUTH_DB_URL } from "./tests/flows/local-db";

// Offline tills (decision 0006) in a real browser with the network switched
// off and on. The service worker runs only in a production build, so this
// builds the app and starts it, against the LOCAL throwaway test database.
//   npm run test:offline
const PORT = 3300;

export default defineConfig({
  testDir: "tests/offline",
  globalSetup: "./tests/flows/global-setup.ts",
  workers: 1,
  reporter: "list",
  expect: { timeout: 20_000 },
  use: { baseURL: `http://localhost:${String(PORT)}`, trace: "retain-on-failure", actionTimeout: 30_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npx next start -p ${String(PORT)}`,
    url: `http://localhost:${String(PORT)}`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      DATABASE_URL_DEV: LOCAL_APP_DB_URL,
      AUTH_DATABASE_URL_DEV: LOCAL_AUTH_DB_URL,
      BETTER_AUTH_URL: `http://localhost:${String(PORT)}`,
      // A production build requires email settings. These are deliberately
      // fake: the tests never trigger an email (logins are made in the
      // database, tests/offline/account.ts).
      RESEND_API_KEY: "re_offline_tests_not_a_key",
      EMAIL_FROM: "Offline tests <offline@test.invalid>",
    },
  },
});
