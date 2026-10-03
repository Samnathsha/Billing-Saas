import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import { guardPool } from "./pool-errors";
import * as schema from "./schema";

// The login library's own connection pool, as auth_service (ADR 0003). It
// reaches the login tables only; the database refuses every business table.
// Only src/modules/auth may import this file (lint rule).

export type AuthDatabase = NodePgDatabase<typeof schema> & { $client: Pool };

const globalForAuthDb = globalThis as typeof globalThis & { __billingAuthDb?: AuthDatabase };

export function getAuthDb(): AuthDatabase {
  globalForAuthDb.__billingAuthDb ??= drizzle({
    client: guardPool(
      new Pool({
        connectionString: env.authDatabaseUrl,
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
      }),
      "login",
    ),
    schema,
  });
  return globalForAuthDb.__billingAuthDb;
}
