import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withUserTransaction } from "@/db/with-tenant";
import { requireCapacity } from "@/modules/plans";
import { auth } from "./better-auth";
import { hashInvitationToken } from "./invitation-token";
import * as repo from "./repo";
import { getActiveSession } from "./request-context";

// "Set up your business" (ADR 0003, amendment 1). For a logged-in user with a
// verified email and no business yet. No permission check: the user has no
// business, hence no role, yet; the checks below are the gate.

export type OnboardingErrorCode = "NOT_LOGGED_IN" | "EMAIL_NOT_VERIFIED" | "ACCOUNT_DISABLED" | "ALREADY_HAS_BUSINESS";

export class OnboardingError extends Error {
  constructor(public readonly code: OnboardingErrorCode) {
    super(code);
    this.name = "OnboardingError";
  }
}

// Strict: any other field (e.g. a forged tenantId or role) is rejected.
export const createBusinessInput = z.strictObject({
  businessName: z.string().trim().min(1).max(200),
  template: z.enum(["clothing", "mobile"]),
});

export async function createBusiness(headers: Headers, rawInput: unknown): Promise<{ tenantId: string }> {
  const session = await auth.api.getSession({ headers });
  if (session === null) throw new OnboardingError("NOT_LOGGED_IN");
  if (!session.user.emailVerified) throw new OnboardingError("EMAIL_NOT_VERIFIED");
  if (session.user.status !== "active") throw new OnboardingError("ACCOUNT_DISABLED");
  const input = createBusinessInput.parse(rawInput);

  const userId = session.user.id;
  const tenantId = randomUUID();

  // One transaction: lock, check, create. A double click waits for the lock,
  // then finds the membership and stops.
  await withUserTransaction(userId, async (tx, scope) => {
    await repo.lockUserForBusinessCreation(tx, userId);
    if ((await repo.countActiveMemberships(tx, userId)) > 0) throw new OnboardingError("ALREADY_HAS_BUSINESS");
    const business = await scope.enterTenant(tenantId);
    await repo.insertBusiness(business.tx, business.ctx, input);
  });

  await repo.setSessionActiveTenant(session.session.token, tenantId);
  return { tenantId };
}

// ---------------------------------------------------------------------------
// Accepting a staff invitation (Phase 4). For a logged-in user with a
// confirmed email. The business comes from the invitation row the database
// lets this user see (addressed to their own email), never from the link.
// ---------------------------------------------------------------------------

export type AcceptInvitationErrorCode =
  | "NOT_LOGGED_IN"
  | "INVITATION_INVALID"
  | "INVITATION_EXPIRED"
  | "ALREADY_IN_A_BUSINESS";

const ACCEPT_MESSAGES: Record<AcceptInvitationErrorCode, string> = {
  NOT_LOGGED_IN: "Please log in with the email address the invitation was sent to.",
  INVITATION_INVALID:
    "This invitation link is not valid for this account. It may have been used or withdrawn, or it was sent to another email address.",
  INVITATION_EXPIRED: "This invitation has expired. Ask the business owner to send a new one.",
  ALREADY_IN_A_BUSINESS: "Your account already belongs to a business. One business per account for now.",
};

export class AcceptInvitationError extends Error {
  constructor(public readonly code: AcceptInvitationErrorCode) {
    super(ACCEPT_MESSAGES[code]);
    this.name = "AcceptInvitationError";
  }
}

export const acceptInvitationInput = z.strictObject({ token: z.string().min(20).max(200) });

export async function acceptInvitation(headers: Headers, rawInput: unknown): Promise<{ tenantId: string }> {
  // Logged in, active, confirmed email (getActiveSession checks all three).
  const session = await getActiveSession(headers);
  if (session === undefined) throw new AcceptInvitationError("NOT_LOGGED_IN");
  const parsed = acceptInvitationInput.safeParse(rawInput);
  if (!parsed.success) throw new AcceptInvitationError("INVITATION_INVALID");
  const tokenHash = hashInvitationToken(parsed.data.token);
  const userId = session.userId;

  const tenantId = await withUserTransaction(userId, async (tx, scope) => {
    // Same per-user lock as creating a business: one business per account.
    await repo.lockUserForBusinessCreation(tx, userId);
    const found = await repo.findInvitationForUser(tx, tokenHash);
    if (found === undefined || found.status !== "pending") throw new AcceptInvitationError("INVITATION_INVALID");
    if (found.expiresAt.getTime() <= Date.now()) throw new AcceptInvitationError("INVITATION_EXPIRED");
    if ((await repo.countActiveMemberships(tx, userId)) > 0) throw new AcceptInvitationError("ALREADY_IN_A_BUSINESS");

    const business = await scope.enterTenant(found.tenantId);
    // Re-read under a lock inside the business: two clicks cannot both join.
    const invitation = await repo.lockInvitation(business.tx, found.id);
    if (invitation === undefined || invitation.status !== "pending") throw new AcceptInvitationError("INVITATION_INVALID");
    await repo.setInvitationStatus(business.tx, invitation.id, { status: "accepted", acceptedBy: userId, acceptedAt: new Date() });
    // Accepted first, so this invitation is no longer counted as open.
    await requireCapacity(business.tx, business.ctx, "users");
    await repo.addMembership(business.tx, business.ctx, invitation.roleId);
    await repo.addAuditEntry(business.tx, business.ctx, {
      actorRole: (await repo.memberRoleName(business.tx, userId)) ?? "unknown",
      action: "member.joined",
      entityType: "invitation",
      entityId: invitation.id,
      before: { status: "pending" },
      after: { status: "accepted", userId },
    });
    return found.tenantId;
  });

  await repo.setSessionActiveTenant(session.token, tenantId);
  return { tenantId };
}
