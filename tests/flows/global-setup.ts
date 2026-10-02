import pg from "pg";
import { LOCAL_AUTH_DB_URL } from "./local-db";

// Each run starts with fresh login-limit counters, so repeated runs are not
// throttled by the per-IP limits of earlier runs. LOCAL throwaway database
// only (see local-db.ts).
export default async function globalSetup(): Promise<void> {
  const client = new pg.Client({ connectionString: LOCAL_AUTH_DB_URL });
  await client.connect();
  try {
    await client.query("DELETE FROM rate_limits");
  } finally {
    await client.end();
  }
}
