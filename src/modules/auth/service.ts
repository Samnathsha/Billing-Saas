import "server-only";
import { z } from "zod";
import { withTenant, type TenantContext, type TenantTx } from "@/db/with-tenant";
import { env } from "@/lib/env";
import { requireCapacity } from "@/modules/plans";
import { OWNER_ROLE } from "./default-roles";
import { hashInvitationToken, newInvitationToken } from "./invitation-token";
import { sendEmail } from "./mailer";
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

// ---------------------------------------------------------------------------
// Staff list and invitations (blueprint Phase 4). The link in the email
// works once, for 7 days, and only for the invited address (accepting:
// onboarding.ts). Only the SHA-256 hash of its secret is stored. Open
// invitations count against the plan's staff limit.
// ---------------------------------------------------------------------------

export const INVITATION_DAYS = 7;

export type InvitationErrorCode = "ROLE_NOT_FOUND" | "CANNOT_ASSIGN_OWNER" | "ALREADY_MEMBER" | "NOT_FOUND" | "NOT_PENDING";

const INVITATION_MESSAGES: Record<InvitationErrorCode, string> = {
  ROLE_NOT_FOUND: "This role was not found.",
  CANNOT_ASSIGN_OWNER: "The owner role cannot be given this way.",
  ALREADY_MEMBER: "This email address already belongs to someone in this business.",
  NOT_FOUND: "This invitation was not found.",
  NOT_PENDING: "This invitation is no longer open.",
};

export class InvitationError extends Error {
  constructor(public readonly code: InvitationErrorCode) {
    super(INVITATION_MESSAGES[code]);
    this.name = "InvitationError";
  }
}

export interface StaffDto {
  members: {
    userId: string;
    name: string;
    email: string;
    roleId: string;
    roleName: string;
    active: boolean;
    isOwner: boolean;
    isYou: boolean;
  }[];
  invitations: { id: string; email: string; roleName: string; expiresAt: string; expired: boolean }[];
  // Roles that can be given (never Owner).
  roles: { id: string; name: string }[];
}

export const inviteStaffInput = z.strictObject({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: "Enter a valid email address." }).max(254, { error: "Use at most 254 characters." })),
  roleId: z.uuid({ error: "Choose a role." }),
});
export const invitationIdInput = z.strictObject({ invitationId: z.uuid() });

export async function listStaff(ctx: TenantContext): Promise<StaffDto> {
  await requirePermission(ctx, "users.manage");
  return withTenant(ctx, async (tx) => {
    const now = Date.now();
    const members = await repo.listMembers(tx);
    const invitations = await repo.listPendingInvitations(tx);
    const roles = await repo.listRoles(tx);
    return {
      members: members.map((m) => ({
        userId: m.userId,
        name: m.name,
        email: m.email,
        roleId: m.roleId,
        roleName: m.roleName,
        active: m.status === "active",
        isOwner: isOwnerRole({ name: m.roleName, isSystem: m.roleIsSystem }),
        isYou: m.userId === ctx.userId,
      })),
      invitations: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        roleName: i.roleName,
        expiresAt: i.expiresAt.toISOString(),
        expired: i.expiresAt.getTime() <= now,
      })),
      roles: roles.filter((r) => !isOwnerRole(r)).map((r) => ({ id: r.id, name: r.name })),
    };
  });
}

// Invites by email. Inviting the same address again replaces the earlier
// link (the old one stops working). The answer never says whether the
// address has an account anywhere.
export async function inviteStaff(ctx: TenantContext, rawInput: unknown): Promise<{ invitationId: string }> {
  await requirePermission(ctx, "users.manage");
  const input = inviteStaffInput.parse(rawInput);
  const token = newInvitationToken();
  const expiresAt = new Date(Date.now() + INVITATION_DAYS * 24 * 60 * 60 * 1000);

  const sent = await withTenant(ctx, async (tx) => {
    const role = await repo.findRoleById(tx, input.roleId);
    if (role === undefined) throw new InvitationError("ROLE_NOT_FOUND");
    if (isOwnerRole(role)) throw new InvitationError("CANNOT_ASSIGN_OWNER");
    if (await repo.emailIsMember(tx, input.email)) throw new InvitationError("ALREADY_MEMBER");
    const replaced = await repo.revokePendingFor(tx, input.email);
    await requireCapacity(tx, ctx, "users");
    const invitationId = await repo.insertInvitation(tx, ctx, {
      email: input.email,
      roleId: role.id,
      tokenHash: hashInvitationToken(token),
      expiresAt,
    });
    await repo.addAuditEntry(tx, ctx, {
      actorRole: (await repo.memberRoleName(tx, ctx.userId)) ?? "unknown",
      action: "member.invited",
      entityType: "invitation",
      entityId: invitationId,
      before: replaced.length > 0 ? { replacedInvitations: replaced } : null,
      after: { email: input.email, roleId: role.id, roleName: role.name },
    });
    return { invitationId, roleName: role.name, business: await repo.businessName(tx) };
  });

  // After the commit. If sending fails, the invitation stays open and can
  // be sent again; the error is reported to the caller.
  const link = `${env.authUrl}/invite?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: input.email,
    subject: `You are invited to join ${sent.business}`,
    text:
      `${sent.business} invited you to join as ${sent.roleName}.\n\n` +
      `To accept, open this link within ${String(INVITATION_DAYS)} days:\n\n${link}\n\n` +
      `You will need to log in, or create an account, with this email address (${input.email}).\n` +
      `If you did not expect this, ignore this email.`,
  });
  return { invitationId: sent.invitationId };
}

export async function revokeInvitation(ctx: TenantContext, rawInput: unknown): Promise<void> {
  await requirePermission(ctx, "users.manage");
  const { invitationId } = invitationIdInput.parse(rawInput);
  await withTenant(ctx, async (tx) => {
    const invitation = await repo.lockInvitation(tx, invitationId);
    if (invitation === undefined) throw new InvitationError("NOT_FOUND");
    if (invitation.status !== "pending") throw new InvitationError("NOT_PENDING");
    await repo.setInvitationStatus(tx, invitation.id, { status: "revoked" });
    await repo.addAuditEntry(tx, ctx, {
      actorRole: (await repo.memberRoleName(tx, ctx.userId)) ?? "unknown",
      action: "member.invitation_revoked",
      entityType: "invitation",
      entityId: invitation.id,
      before: { status: "pending", email: invitation.email },
      after: { status: "revoked" },
    });
  });
}
