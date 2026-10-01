import "server-only";
import { parseEnv } from "./env-schema";

// Validated settings. Import `env` instead of reading process.env directly.
// "server-only" makes the build fail if browser code imports this file, so
// the database password can never reach the browser.
export const env = parseEnv(process.env);
