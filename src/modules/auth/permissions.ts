import "server-only";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { PERMISSIONS, type Permission } from "./default-roles";
import * as repo from "./repo";

// Blueprint 5.3: every service function starts with
//   await requirePermission(ctx, "sales.create");
// The server decides; the browser only hides buttons. The check reads the
// member's CURRENT role from the database each time, so removing a
// permission, changing a role or disabling a member works at once, even for
// a context made earlier in the same request. A lint rule makes service.ts
// functions start with this call.

export class PermissionDeniedError extends Error {
  readonly code = "FORBIDDEN";
  constructor(public readonly permission: Permission) {
    // Safe to show to the user: names no data, only that it was refused.
    super("You do not have permission to do this.");
    this.name = "PermissionDeniedError";
  }
}

const KNOWN: ReadonlySet<string> = new Set(PERMISSIONS);

export async function requirePermission(ctx: TenantContext, permission: Permission): Promise<void> {
  // A typo cast past TypeScript is a programming error, not a refusal.
  if (!KNOWN.has(permission)) throw new Error("requirePermission: unknown permission code");
  const allowed = await withTenant(ctx, (tx) => repo.memberHasPermission(tx, ctx, permission));
  if (!allowed) throw new PermissionDeniedError(permission);
}
