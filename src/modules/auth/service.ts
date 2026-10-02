import "server-only";
import { z } from "zod";
import { withTenant, type TenantContext, type TenantTx } from "@/db/with-tenant";
import { OWNER_ROLE } from "./default-roles";
import { requirePermission } from "./permissions";
import * as repo from "./repo";

// Staff management: change a member's role, deactivate a member (blueprint
// 5.2/5.3; owner decisions 2026-10-02, docs/business-rules.md):
// - Needs "users.manage" (Owner and Admin by default).
// - Nobody can change or deactivate the Owner, or themselves.
// - Any role except Owner can be given (ownership transfer is separate).
// - Afterwards ALL the member's sessions end at once, on every device: they
//   log in again and get a fresh session with the new role.
// Invitations and the screens come in Phase 4.

export type MemberErrorCode =
  | "MEMBER_NOT_FOUND"
  | "ROLE_NOT_FOUND"
  | "CANNOT_CHANGE_SELF"
  | "CANNOT_CHANGE_OWNER"
  | "CANNOT_ASSIGN_OWNER";

const MESSAGES: Record<MemberErrorCode, string> = {
  MEMBER_NOT_FOUND: "This staff member was not found.",
  ROLE_NOT_FOUND: "This role was not found.",
  CANNOT_CHANGE_SELF: "You cannot change your own access.",
  CANNOT_CHANGE_OWNER: "The owner's access cannot be changed.",
  CANNOT_ASSIGN_OWNER: "The owner role cannot be given this way.",
};

export class MemberError extends Error {
  constructor(public readonly code: MemberErrorCode) {
    super(MESSAGES[code]);
    this.name = "MemberError";
  }
}

export const changeMemberRoleInput = z.strictObject({ userId: z.uuid(), roleId: z.uuid() });
export const deactivateMemberInput = z.strictObject({ userId: z.uuid() });

const isOwnerRole = (role: { name: string; isSystem: boolean }): boolean => role.isSystem && role.name === OWNER_ROLE;

// The member to change, after the rules every change shares. Also returns
// the caller's own role name for the audit entry.
async function lockChangeableMember(
  tx: TenantTx,
  ctx: TenantContext,
  userId: string,
): Promise<{ member: repo.MemberRow; actorRole: string }> {
  if (userId === ctx.userId) throw new MemberError("CANNOT_CHANGE_SELF");
  const member = await repo.lockMember(tx, userId);
  if (member === undefined) throw new MemberError("MEMBER_NOT_FOUND");
  if (isOwnerRole({ name: member.roleName, isSystem: member.roleIsSystem })) throw new MemberError("CANNOT_CHANGE_OWNER");
  // Read without a lock: two admins changing each other must not deadlock.
  const actorRole = (await repo.memberRoleName(tx, ctx.userId)) ?? "unknown";
  return { member, actorRole };
}

export async function changeMemberRole(ctx: TenantContext, rawInput: unknown): Promise<{ changed: boolean }> {
  await requirePermission(ctx, "users.manage");
  const input = changeMemberRoleInput.parse(rawInput);

  const changed = await withTenant(ctx, async (tx) => {
    const { member, actorRole } = await lockChangeableMember(tx, ctx, input.userId);
    const role = await repo.findRoleById(tx, input.roleId);
    if (role === undefined) throw new MemberError("ROLE_NOT_FOUND");
    if (isOwnerRole(role)) throw new MemberError("CANNOT_ASSIGN_OWNER");
    if (role.id === member.roleId) return false;
    await repo.setMemberRole(tx, member, role.id);
    await repo.addAuditEntry(tx, ctx, {
      actorRole,
      action: "member.role_changed",
      entityType: "membership",
      entityId: member.membershipId,
      before: { userId: member.userId, roleId: member.roleId, roleName: member.roleName },
      after: { userId: member.userId, roleId: role.id, roleName: role.name },
    });
    return true;
  });

  if (changed) await endSessionsOf(ctx, input.userId, "member.role_changed");
  return { changed };
}

export async function deactivateMember(ctx: TenantContext, rawInput: unknown): Promise<{ changed: boolean }> {
  await requirePermission(ctx, "users.manage");
  const input = deactivateMemberInput.parse(rawInput);

  const changed = await withTenant(ctx, async (tx) => {
    const { member, actorRole } = await lockChangeableMember(tx, ctx, input.userId);
    if (member.status !== "active") return false;
    await repo.disableMember(tx, member);
    await repo.addAuditEntry(tx, ctx, {
      actorRole,
      action: "member.deactivated",
      entityType: "membership",
      entityId: member.membershipId,
      before: { userId: member.userId, status: member.status },
      after: { userId: member.userId, status: "disabled" },
    });
    return true;
  });

  // Ended even if it was already disabled: harmless, and it closes any
  // session left over from an earlier failure.
  await endSessionsOf(ctx, input.userId, "member.deactivated");
  return { changed };
}

// After the change is saved. If this step failed, the change would still
// apply at once: every request re-reads the membership and role
// (getRequestContext, requirePermission); the sessions would just remain
// listed until they expire.
async function endSessionsOf(ctx: TenantContext, userId: string, reason: string): Promise<void> {
  const ended = await repo.deleteAllUserSessions(userId);
  await repo.addSecurityEvent({
    event: "auth.sessions_ended_by_admin",
    userId,
    ip: null,
    userAgent: null,
    details: { reason, byUserId: ctx.userId, tenantId: ctx.tenantId, sessions: ended },
  });
}
