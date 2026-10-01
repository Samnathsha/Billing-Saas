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
