import { addMember as addSharedMember, type StaffRole } from "../../scripts/lib/add-member";

// The local throwaway test database (docs/database-setup.md). Fixed here, so
// the flow tests can never point at Neon. No passwords: it trusts local
// connections.
const LOCAL_DB = "localhost:55432/billing_test";
export const LOCAL_APP_DB_URL = `postgresql://app_user@${LOCAL_DB}`;
export const LOCAL_AUTH_DB_URL = `postgresql://auth_service@${LOCAL_DB}`;

// Adds an existing user to the owner's business with a role (the same code
// as `npm run dev:add-member`).
export function addMember(ownerEmail: string, memberEmail: string, role: StaffRole): Promise<void> {
  return addSharedMember({ app: LOCAL_APP_DB_URL, auth: LOCAL_AUTH_DB_URL }, { ownerEmail, memberEmail, role });
}
