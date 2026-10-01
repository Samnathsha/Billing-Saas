import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";
import { z } from "zod";

// Migrations always run as the migrator role (owner of the tables), never as
// app_user and never as the Neon owner.
//   npm run db:migrate        -> dev database  (MIGRATOR_DATABASE_URL_DEV)
//   npm run db:migrate:test   -> test database (MIGRATOR_DATABASE_URL_TEST)
// In CI the variable is set by the workflow instead of .env.local.

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const target = z.enum(["dev", "test"]).parse(process.env.DB_TARGET ?? "dev");
const variable = target === "test" ? "MIGRATOR_DATABASE_URL_TEST" : "MIGRATOR_DATABASE_URL_DEV";
const url = z.url({ protocol: /^postgres(ql)?$/ }).safeParse(process.env[variable]);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/modules/*/schema.ts",
  out: "./drizzle",
  // Only commands that talk to the database need the URL; `generate` does not.
  dbCredentials: { url: url.success ? url.data : "postgres://missing-url.invalid/missing" },
  migrations: { schema: "drizzle", table: "__drizzle_migrations" },
  strict: true,
  verbose: true,
});
