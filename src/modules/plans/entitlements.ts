import "server-only";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import * as repo from "./repo";

// Plan limits (blueprint Phase 4; pilot plan: business rules section 11).
// Call requireCapacity inside the SAME transaction that adds the branch,
// member or till, after the caller's own permission check: it locks, counts
// and refuses when the plan is full. A business without an active plan
// cannot add anything (fails closed).

export type { PlanResource } from "./repo";

export type PlanLimitErrorCode = "LIMIT_REACHED" | "NO_ACTIVE_PLAN";

const NAMES: Record<repo.PlanResource, string> = { branches: "branches", users: "staff members", devices: "tills" };

export class PlanLimitError extends Error {
  constructor(
    public readonly code: PlanLimitErrorCode,
    public readonly resource: repo.PlanResource,
    public readonly limit: number | null,
  ) {
    super(
      code === "LIMIT_REACHED"
        ? `Your plan allows ${String(limit)} ${NAMES[resource]}. Remove one or change the plan to add more.`
        : "This business has no active plan. Please contact support.",
    );
    this.name = "PlanLimitError";
  }
}

const ACTIVE = new Set(["trialing", "active", "past_due"]);

export function limitOf(plan: repo.PlanRow, resource: repo.PlanResource): number {
  if (resource === "branches") return plan.maxBranches;
  if (resource === "users") return plan.maxUsers;
  return plan.maxDevices;
}

export async function requireCapacity(tx: TenantTx, ctx: TenantContext, resource: repo.PlanResource): Promise<void> {
  await repo.lockPlanCapacity(tx, ctx, resource);
  const plan = await repo.currentPlan(tx, ctx);
  if (plan === undefined || !ACTIVE.has(plan.status)) throw new PlanLimitError("NO_ACTIVE_PLAN", resource, null);
  const limit = limitOf(plan, resource);
  const used = (await repo.countUsage(tx, ctx))[resource];
  if (used >= limit) throw new PlanLimitError("LIMIT_REACHED", resource, limit);
}

// Plan and usage for display ("Your plan"). Inside the caller's transaction;
// the caller checks its own permission.
export async function readPlanUsage(
  tx: TenantTx,
  ctx: TenantContext,
): Promise<{ plan: repo.PlanRow; used: Record<repo.PlanResource, number> } | undefined> {
  const plan = await repo.currentPlan(tx, ctx);
  if (plan === undefined) return undefined;
  return { plan, used: await repo.countUsage(tx, ctx) };
}
