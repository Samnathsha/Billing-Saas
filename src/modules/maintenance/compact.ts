import "server-only";
import { compactOldRows as compact } from "@/db/maintenance";

// The nightly removal of old technical rows (migration 0040). What goes is
// decided by the database function alone.
export async function compactOldRows(): Promise<Record<string, number>> {
  return compact();
}
