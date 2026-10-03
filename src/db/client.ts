import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import { guardPool } from "./pool-errors";
import * as schema from "./schema";

// The one connection pool, as app_user. Only src/db may import this file
// (lint rule); modules reach the database through withTenant().

export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

// Reused across hot reloads in development, so each reload does not open a
// new pool.
const globalForDb = globalThis as typeof globalThis & { __billingDb?: Database };

export function getDb(): Database {
  globalForDb.__billingDb ??= drizzle({
    client: guardPool(
      new Pool({
        connectionString: env.databaseUrl,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
      }),
      "app",
    ),
    schema,
  });
  return globalForDb.__billingDb;
}

export class UnsafeDatabaseRoleError extends Error {
  constructor(role: string) {
    super(
      `The app's database connection uses role "${role}", which is not the restricted app_user. ` +
        "Fix DATABASE_URL_* in .env.local (see docs/database-setup.md).",
    );
    this.name = "UnsafeDatabaseRoleError";
  }
}

// The app must never run as the owner or migrator: they are not bound by the
// same rules. Checked once at startup (src/instrumentation-node.ts).
export async function assertRestrictedDatabaseRole(): Promise<void> {
  const result = await getDb().$client.query<{ role: string; unsafe: boolean }>(
    `SELECT current_user AS role,
            (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb) AS unsafe
       FROM pg_roles WHERE rolname = current_user`,
  );
  const row = result.rows[0];
  if (row === undefined || row.role !== "app_user" || row.unsafe) {
    throw new UnsafeDatabaseRoleError(row?.role ?? "unknown");
  }
}
