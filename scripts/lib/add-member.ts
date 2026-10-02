import pg from "pg";

// Adds an existing, confirmed user to the owner's business with a role,
// until staff invitations exist (Phase 4). Looks the two users up through
// the login role, then inserts the membership as app_user INSIDE the
// owner's business, so row-level security applies exactly as in the app.
// Used by `npm run dev:add-member` and the flow tests.

const ROLES = ["Admin", "Manager", "Cashier", "Accountant"] as const;
export type StaffRole = (typeof ROLES)[number];
export const isStaffRole = (value: string): value is StaffRole => (ROLES as readonly string[]).includes(value);

export async function addMember(
  urls: { app: string; auth: string },
  input: { ownerEmail: string; memberEmail: string; role: StaffRole },
): Promise<void> {
  const auth = new pg.Client({ connectionString: urls.auth });
  await auth.connect();
  let ownerId: string | undefined;
  let memberId: string | undefined;
  try {
    const { rows } = await auth.query<{ id: string; email: string; ok: boolean }>(
      "SELECT id, lower(email) AS email, (email_verified AND status = 'active') AS ok FROM users WHERE lower(email) = ANY($1::text[])",
      [[input.ownerEmail.toLowerCase(), input.memberEmail.toLowerCase()]],
    );
    const find = (email: string) => rows.find((r) => r.email === email.toLowerCase());
    const owner = find(input.ownerEmail);
    const member = find(input.memberEmail);
    if (owner === undefined) throw new Error("The owner's email has no account.");
    if (member?.ok !== true) throw new Error("The staff email has no confirmed, active account. Register and confirm it first.");
    ownerId = owner.id;
    memberId = member.id;
  } finally {
    await auth.end();
  }

  const app = new pg.Client({ connectionString: urls.app });
  await app.connect();
  try {
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.user_id', $1, true)", [ownerId]);
    // Login view: the owner's own active memberships (roles are not visible
    // until a business is entered).
    const { rows: owned } = await app.query<{ tenant_id: string; role_id: string }>(
      "SELECT tenant_id, role_id FROM memberships WHERE user_id = $1 AND status = 'active'",
      [ownerId],
    );
    const membership = owned[0];
    if (membership === undefined || owned.length !== 1) throw new Error("The owner's email does not have exactly one business.");
    const tenantId = membership.tenant_id;
    await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows: ownerRole } = await app.query(
      "SELECT 1 FROM roles WHERE id = $1 AND name = 'Owner' AND is_system",
      [membership.role_id],
    );
    if (ownerRole.length !== 1) throw new Error("The owner's email is not the Owner of that business.");
    const { rows: roles } = await app.query<{ id: string }>("SELECT id FROM roles WHERE name = $1", [input.role]);
    if (roles[0] === undefined) throw new Error("That role does not exist in this business.");
    const { rowCount } = await app.query("SELECT 1 FROM memberships WHERE user_id = $1", [memberId]);
    if ((rowCount ?? 0) > 0) throw new Error("This person is already in the business.");
    await app.query("INSERT INTO memberships (tenant_id, user_id, role_id, created_by) VALUES ($1, $2, $3, $4)", [
      tenantId,
      memberId,
      roles[0].id,
      ownerId,
    ]);
    await app.query(
      "INSERT INTO audit_logs (tenant_id, actor_user_id, actor_role, action, entity_type, entity_id, after) VALUES ($1, $2, 'Owner', 'member.added', 'user', $3, $4)",
      [tenantId, ownerId, memberId, JSON.stringify({ role: input.role, via: "dev:add-member" })],
    );
    await app.query("COMMIT");
  } catch (error) {
    await app.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await app.end();
  }
}
