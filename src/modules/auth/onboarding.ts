import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withUserTransaction } from "@/db/with-tenant";
import { auth } from "./better-auth";
import * as repo from "./repo";

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
