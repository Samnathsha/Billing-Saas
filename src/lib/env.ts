import "server-only";
import { parseEnv, type Env } from "./env-schema";

// Validated settings. Import `env` instead of reading process.env directly.
// "server-only" makes the build fail if browser code imports this file, so
// the database password can never reach the browser.
//
// Checked on first use, not when the file loads (Phase 12): a container
// image is built without any settings (it must hold no secrets). The server
// still checks everything at startup, before the first request
// (src/instrumentation-node.ts calls validateEnv), and stops if anything is
// wrong.
let checked: Env | null = null;

// Only while `next build` runs (it loads route files to read their
// settings, but serves nothing): obviously fake values, never cached and
// never used to serve a request.
const BUILD_PLACEHOLDER: Env = {
  mode: "production",
  appEnv: "local",
  databaseUrl: "postgresql://build.invalid/none",
  authDatabaseUrl: "postgresql://build-auth.invalid/none",
  authSecret: "build-time-placeholder-never-used-for-anything",
  authUrl: "https://build.invalid",
  email: null,
  healthDrill: false,
  cronSecret: null,
};

export function validateEnv(): Env {
  if (checked !== null) return checked;
  if (process.env.NEXT_PHASE === "phase-production-build") {
    try {
      return parseEnv(process.env);
    } catch {
      return BUILD_PLACEHOLDER;
    }
  }
  checked = parseEnv(process.env);
  return checked;
}

export const env: Env = new Proxy({} as Env, {
  get: (_target, key) => validateEnv()[key as keyof Env],
});
