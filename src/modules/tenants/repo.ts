import "server-only";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { auditLogs, branches, devices, memberships, plans, roles, settings, subscriptions, tenants } from "@/db/schema";

// Database queries of the tenants module. Everything runs inside the
// caller's withTenant transaction; row-level security limits it to the
// caller's business.

export interface ProfileRow {
  businessName: string;
  template: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  stateCode: string | null;
  pincode: string | null;
  phone: string | null;
  contactEmail: string | null;
  gstRegistration: string | null;
  gstin: string | null;
  pricesIncludeTax: boolean;
  invoicePrefix: string;
  creditNotePrefix: string;
  timeZone: string;
  financialYearStartMonth: number;
  version: number;
}

const profileColumns = {
  businessName: tenants.name,
  template: tenants.template,
  addressLine1: settings.addressLine1,
  addressLine2: settings.addressLine2,
  city: settings.city,
  stateCode: settings.stateCode,
  pincode: settings.pincode,
  phone: settings.phone,
  contactEmail: settings.contactEmail,
  gstRegistration: settings.gstRegistration,
  gstin: settings.gstin,
  pricesIncludeTax: settings.pricesIncludeTax,
  invoicePrefix: settings.invoicePrefix,
  creditNotePrefix: settings.creditNotePrefix,
  timeZone: settings.timeZone,
  financialYearStartMonth: settings.financialYearStartMonth,
  version: settings.version,
};

export async function getProfile(tx: TenantTx, ctx: TenantContext): Promise<ProfileRow | undefined> {
  const [row] = await tx
    .select(profileColumns)
    .from(settings)
    .innerJoin(tenants, eq(tenants.id, settings.tenantId))
    .where(eq(settings.tenantId, ctx.tenantId));
  return row;
}

// Locks the settings row until the end of the transaction, so two saves
// cannot cross.
export async function lockProfile(tx: TenantTx, ctx: TenantContext): Promise<ProfileRow | undefined> {
  const [row] = await tx
    .select(profileColumns)
    .from(settings)
    .innerJoin(tenants, eq(tenants.id, settings.tenantId))
    .where(eq(settings.tenantId, ctx.tenantId))
    .for("update", { of: settings });
  return row;
}

export type ProfileValues = Omit<ProfileRow, "template" | "version" | "timeZone" | "financialYearStartMonth">;

export async function saveProfile(tx: TenantTx, ctx: TenantContext, values: ProfileValues, version: number): Promise<void> {
  const { businessName, ...rest } = values;
  await tx.update(tenants).set({ name: businessName }).where(eq(tenants.id, ctx.tenantId));
  await tx.update(settings).set({ ...rest, version }).where(eq(settings.tenantId, ctx.tenantId));
}

// The caller's role name, kept as text in the audit entry.
export async function actorRoleName(tx: TenantTx, ctx: TenantContext): Promise<string> {
  const [row] = await tx
    .select({ name: roles.name })
    .from(memberships)
    .innerJoin(roles, and(eq(roles.tenantId, memberships.tenantId), eq(roles.id, memberships.roleId)))
    .where(eq(memberships.userId, ctx.userId));
  return row?.name ?? "unknown";
}

export async function addAuditEntry(
  tx: TenantTx,
  ctx: TenantContext,
  entry: { actorRole: string; action: string; entityType: string; entityId: string; before: object; after: object },
): Promise<void> {
  await tx.insert(auditLogs).values({ tenantId: ctx.tenantId, actorUserId: ctx.userId, ...entry });
}

// ---------------------------------------------------------------------------
// Plans and limits.
// ---------------------------------------------------------------------------

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

// What counts against the plan: open branches, active members (owner
// included), active tills.
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
  return { branches: b?.n ?? 0, users: u?.n ?? 0, devices: d?.n ?? 0 };
}
