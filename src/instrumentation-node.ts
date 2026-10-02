import { EnvError } from "@/lib/env-schema";

// Loading env.ts validates the settings. Stop the app at startup if they are
// wrong, instead of failing later on the first database call.
try {
  await import("@/lib/env");
} catch (error) {
  if (error instanceof EnvError) {
    console.error(`\n${error.message}\nSee .env.example for the required names.\n`);
    process.exit(1);
  }
  throw error;
}

// Refuse to run with a database login that is not the restricted app_user
// (e.g. the Neon owner pasted by mistake). If the database is only
// unreachable, start anyway and log it, so a short outage does not stop the
// server.
const { assertRestrictedDatabaseRole, UnsafeDatabaseRoleError } = await import("@/db/client");
try {
  await assertRestrictedDatabaseRole();
} catch (error) {
  if (error instanceof UnsafeDatabaseRoleError) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
  const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
  console.error(`Startup database check skipped: database not reachable (code ${code}).`);
}
