import { existsSync } from "node:fs";
import { installHibpStandIn } from "./helpers/hibp";

// Database tests read DATABASE_URL_TEST (app_user on the test database).
// Locally it comes from .env.local; in CI the workflow sets it. Values that
// are already set (e.g. by CI) are not overwritten.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

// Never call the real Have I Been Pwned service from tests.
installHibpStandIn();
