import "server-only";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { branches, devices, invitations, memberships, plans, subscriptions } from "@/db/schema";

// Database queries of the plans module. Everything runs inside the caller's
// withTenant transaction (row-level security limits it to the business).

export type PlanResource = "branches" | "users" | "devices";

// Serialises "add a branch / member / till" per business and kind until the
// end of the transaction, so two additions cannot both pass the count.
export async function lockPlanCapacity(tx: TenantTx, ctx: TenantContext, resource: PlanResource): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('plan-capacity:' || ${ctx.tenantId} || ':' || ${resource}, 0))`,
  );
}

export interface PlanRow {
  code: string;
  name: string;
  status: string;
  maxBranches: number;
  maxUsers: number;
  maxDevices: number;
}

export async function currentPlan(tx: TenantTx, ctx: TenantContext): Promise<PlanRow | undefined> {
  const [row] = await tx
    .select({
      code: plans.code,
      name: plans.name,
      status: subscriptions.status,
      maxBranches: plans.maxBranches,
      maxUsers: plans.maxUsers,
      maxDevices: plans.maxDevices,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.code, subscriptions.planCode))
    .where(eq(subscriptions.tenantId, ctx.tenantId));
  return row;
}

// What counts against the plan: open branches; active members (owner
// included) plus open, unexpired invitations (so invitations cannot exceed
// the plan); active tills.
export async function countUsage(tx: TenantTx, ctx: TenantContext): Promise<Record<PlanResource, number>> {
  const [b] = await tx
    .select({ n: count() })
    .from(branches)
    .where(and(eq(branches.tenantId, ctx.tenantId), isNull(branches.archivedAt)));
  const [u] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.tenantId, ctx.tenantId), eq(memberships.status, "active")));
  const [d] = await tx
    .select({ n: count() })
    .from(devices)
    .where(and(eq(devices.tenantId, ctx.tenantId), eq(devices.status, "active")));
  const [i] = await tx
    .select({ n: count() })
    .from(invitations)
    .where(
      and(eq(invitations.tenantId, ctx.tenantId), eq(invitations.status, "pending"), gt(invitations.expiresAt, sql`now()`)),
    );
  return { branches: b?.n ?? 0, users: (u?.n ?? 0) + (i?.n ?? 0), devices: d?.n ?? 0 };
}
