import pg from "pg";

// The local throwaway test database (docs/database-setup.md). Fixed here, so
// the flow tests can never point at Neon. No passwords: it trusts local
// connections.
const LOCAL_DB = "localhost:55432/billing_test";
export const LOCAL_APP_DB_URL = `postgresql://app_user@${LOCAL_DB}`;
export const LOCAL_AUTH_DB_URL = `postgresql://auth_service@${LOCAL_DB}`;


// Adds an existing user to the owner's business with the given role, the
// way staff invitations will (Phase 4). As app_user, inside the owner's
// business, so row-level security applies exactly as in the app.
export async function addMember(ownerEmail: string, memberEmail: string, roleName: string): Promise<void> {
  const auth = new pg.Client({ connectionString: LOCAL_AUTH_DB_URL });
  await auth.connect();
  let ids: Map<string, string>;
  try {
    const { rows } = await auth.query<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE email = ANY($1::text[])",
      [[ownerEmail, memberEmail]],
    );
    ids = new Map(rows.map((r) => [r.email, r.id]));
  } finally {
    await auth.end();
  }
  const app = new pg.Client({ connectionString: LOCAL_APP_DB_URL });
  await app.connect();
  try {
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.user_id', $1, true)", [ids.get(ownerEmail)]);
    const { rows: [membership] } = await app.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM memberships WHERE user_id = $1",
      [ids.get(ownerEmail)],
    );
    await app.query("SELECT set_config('app.tenant_id', $1, true)", [membership?.tenant_id]);
    const { rows: [role] } = await app.query<{ id: string }>("SELECT id FROM roles WHERE name = $1", [roleName]);
    await app.query("INSERT INTO memberships (tenant_id, user_id, role_id) VALUES ($1, $2, $3)", [
      membership?.tenant_id,
      ids.get(memberEmail),
      role?.id,
    ]);
    await app.query("COMMIT");
  } finally {
    await app.end();
  }
}
