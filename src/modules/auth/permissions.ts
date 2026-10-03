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

// One permission, or a list meaning "any one of these" (e.g. looking up
// products: whoever sells, manages products or views reports).
export async function requirePermission(ctx: TenantContext, permission: Permission | readonly Permission[]): Promise<void> {
  const wanted = typeof permission === "string" ? [permission] : permission;
  const first = wanted[0];
  // A typo cast past TypeScript is a programming error, not a refusal.
  if (first === undefined || wanted.some((p) => !KNOWN.has(p))) {
    throw new Error("requirePermission: unknown permission code");
  }
  const allowed = await withTenant(ctx, async (tx) => {
    for (const p of wanted) if (await repo.memberHasPermission(tx, ctx, p)) return true;
    return false;
  });
  if (!allowed) throw new PermissionDeniedError(first);
}

// Yes/no, for deciding what to show (e.g. cost price), never as the
// gate of a service function: those start with requirePermission.
export async function hasPermission(ctx: TenantContext, permission: Permission): Promise<boolean> {
  if (!KNOWN.has(permission)) throw new Error("hasPermission: unknown permission code");
  return withTenant(ctx, (tx) => repo.memberHasPermission(tx, ctx, permission));
}
