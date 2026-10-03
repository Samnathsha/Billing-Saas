import type { Pool } from "pg";

// When an idle connection drops (network blip, database restart), pg emits
// an "error" event on the pool with the failed connection attached to the
// error, password included. Without a listener Node crashes and whatever
// prints the crash prints the password. This listener keeps the app running
// (the pool reconnects on the next query) and logs only safe facts.
export function guardPool(pool: Pool, name: string): Pool {
  pool.on("error", (error) => {
    const code = "code" in error ? String(error.code) : "unknown";
    console.error(`database connection lost (${name}, code ${code}); the next query reconnects`);
  });
  return pool;
}
