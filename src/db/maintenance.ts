import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "./client";

// Platform maintenance, outside any business (no tenant context): the
// nightly removal of old technical rows (migration 0040,
// app_compact_old_rows). The database function decides what goes; this
// only calls it.
export async function compactOldRows(): Promise<Record<string, number>> {
  const result = await getDb().execute<{ removed: Record<string, number> }>(sql`SELECT app_compact_old_rows() AS removed`);
  return result.rows[0]?.removed ?? {};
}
