import "server-only";
import { and, eq } from "drizzle-orm";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { auditLogs, memberships, roles, settings, tenants } from "@/db/schema";

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
