import "server-only";
import { and, asc, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { auditLogs, branches, devices, invoiceSequences, memberships, products, roles, settings, tenants, users } from "@/db/schema";

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
// Branches.
// ---------------------------------------------------------------------------

export interface BranchRow {
  id: string;
  name: string;
  archivedAt: Date | null;
  version: number;
}

const branchColumns = { id: branches.id, name: branches.name, archivedAt: branches.archivedAt, version: branches.version };

export async function listBranches(tx: TenantTx): Promise<BranchRow[]> {
  return tx.select(branchColumns).from(branches).orderBy(asc(branches.createdAt), asc(branches.name));
}

// Locks the branch row until the end of the transaction.
export async function lockBranch(tx: TenantTx, branchId: string): Promise<BranchRow | undefined> {
  const [row] = await tx.select(branchColumns).from(branches).where(eq(branches.id, branchId)).for("update");
  return row;
}

// Any branch (open or closed) already using this name, ignoring case.
export async function branchNameTaken(tx: TenantTx, name: string, exceptId: string | null): Promise<boolean> {
  const rows = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(sql`lower(${branches.name}) = lower(${name})`);
  return rows.some((r) => r.id !== exceptId);
}

export async function insertBranch(tx: TenantTx, ctx: TenantContext, name: string): Promise<string> {
  const [row] = await tx
    .insert(branches)
    .values({ tenantId: ctx.tenantId, name, createdBy: ctx.userId })
    .returning({ id: branches.id });
  if (row === undefined) throw new Error("branch insert returned nothing");
  return row.id;
}

export async function updateBranch(
  tx: TenantTx,
  branch: BranchRow,
  values: { name?: string; archivedAt?: Date | null },
): Promise<void> {
  await tx
    .update(branches)
    .set({ ...values, version: branch.version + 1 })
    .where(eq(branches.id, branch.id));
}

// Serialises closing branches per business, so two people cannot close the
// last two open branches at the same moment.
export async function lockBranchClosing(tx: TenantTx, ctx: TenantContext): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('branch-close:' || ${ctx.tenantId}, 0))`);
}

export async function countOpenBranches(tx: TenantTx, ctx: TenantContext): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(branches)
    .where(and(eq(branches.tenantId, ctx.tenantId), isNull(branches.archivedAt)));
  return row?.n ?? 0;
}

// Any product at all (archived ones too): the shop type and "prices include
// GST" are locked once one exists (business rules 11, open question 28).
export async function hasProducts(tx: TenantTx): Promise<boolean> {
  const rows = await tx.select({ id: products.id }).from(products).limit(1);
  return rows.length > 0;
}

export async function setTemplate(tx: TenantTx, ctx: TenantContext, template: "clothing" | "mobile"): Promise<void> {
  await tx.update(tenants).set({ template }).where(eq(tenants.id, ctx.tenantId));
}

// Has this series issued a number in this financial year? (Business rules
// 12: a prefix is locked after the year's first bill.)
export async function seriesStarted(tx: TenantTx, series: { kind: string; prefix: string; financialYear: string }): Promise<boolean> {
  const rows = await tx
    .select({ id: invoiceSequences.id })
    .from(invoiceSequences)
    .where(and(eq(invoiceSequences.series, series.kind), eq(invoiceSequences.prefix, series.prefix), eq(invoiceSequences.financialYear, series.financialYear)))
    .limit(1);
  return rows.length > 0;
}

// Registered tills' prefixes (decision 0006), revoked ones included: their
// series stay theirs.
export async function tillPrefixes(tx: TenantTx): Promise<string[]> {
  const rows = await tx.select({ prefix: devices.prefix }).from(devices).where(isNotNull(devices.prefix));
  return rows.flatMap((r) => (r.prefix === null ? [] : [r.prefix]));
}

// ---------------------------------------------------------------------------
// Business data export and deletion request (Phase 11).
// ---------------------------------------------------------------------------

// Every table holding this business's data, in a readable order. Not
// exported: idempotency keys and synced-operation records (technical
// repeat-protection only). The list is checked against the database by
// tests/integration/business-data.test.ts.
export const EXPORT_TABLES = [
  "settings",
  "subscriptions",
  "branches",
  "roles",
  "role_permissions",
  "memberships",
  "invitations",
  "devices",
  "categories",
  "brands",
  "units",
  "products",
  "product_variants",
  "barcodes",
  "serial_numbers",
  "files",
  "suppliers",
  "customers",
  "purchases",
  "purchase_items",
  "supplier_payments",
  "purchase_returns",
  "purchase_return_items",
  "invoice_sequences",
  "invoices",
  "invoice_items",
  "invoice_payments",
  "customer_payments",
  "credit_notes",
  "credit_note_items",
  "party_ledger_entries",
  "stock_balances",
  "stock_movements",
  "expense_categories",
  "expenses",
  "sync_flags",
  "audit_logs",
] as const;
export const NOT_EXPORTED = ["idempotency_keys", "sync_operations"] as const;
// Secrets never leave the database, even for the owner.
const SECRET_COLUMNS = new Set(["token_hash"]);

export async function exportTable(tx: TenantTx, table: (typeof EXPORT_TABLES)[number]): Promise<Record<string, unknown>[]> {
  const result = await tx.execute(sql`SELECT * FROM ${sql.identifier(table)}`);
  return result.rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !SECRET_COLUMNS.has(column))));
}

export async function businessRow(tx: TenantTx) {
  const [row] = await tx
    .select({ id: tenants.id, name: tenants.name, template: tenants.template, createdAt: tenants.createdAt, deletionRequestedAt: tenants.deletionRequestedAt, deletionDueAt: tenants.deletionDueAt })
    .from(tenants);
  return row;
}

// The people of this business, for the export (names and emails only).
export async function businessPeople(tx: TenantTx) {
  return tx
    .select({ userId: users.id, name: users.displayName, email: users.email, membershipStatus: memberships.status })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId));
}

export async function lastExportAt(tx: TenantTx): Promise<Date | null> {
  const [row] = await tx
    .select({ at: sql<Date | null>`max(${auditLogs.occurredAt})` })
    .from(auditLogs)
    .where(eq(auditLogs.action, "business.exported"));
  return row?.at ?? null;
}

export async function setDeletion(tx: TenantTx, ctx: TenantContext, value: { requestedAt: Date; dueAt: Date } | null): Promise<void> {
  await tx
    .update(tenants)
    .set(
      value === null
        ? { deletionRequestedAt: null, deletionRequestedBy: null, deletionDueAt: null, updatedAt: new Date() }
        : { deletionRequestedAt: value.requestedAt, deletionRequestedBy: ctx.userId, deletionDueAt: value.dueAt, updatedAt: new Date() },
    )
    .where(eq(tenants.id, ctx.tenantId));
}
