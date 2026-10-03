import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { auditLogs, memberships, partyLedgerEntries, roles, suppliers } from "@/db/schema";

// Database queries of the parties module, inside the caller's transaction.

export interface SupplierValues {
  name: string;
  phone: string | null;
  gstin: string | null;
  stateCode: string | null;
}

export async function nameTaken(tx: TenantTx, name: string, exceptId: string | null): Promise<boolean> {
  const rows = await tx.select({ id: suppliers.id }).from(suppliers).where(sql`lower(${suppliers.name}) = lower(${name})`);
  return rows.some((r) => r.id !== exceptId);
}

export async function insertSupplier(tx: TenantTx, ctx: TenantContext, values: SupplierValues): Promise<string> {
  const [row] = await tx
    .insert(suppliers)
    .values({ tenantId: ctx.tenantId, createdBy: ctx.userId, ...values })
    .returning({ id: suppliers.id });
  if (row === undefined) throw new Error("supplier insert returned nothing");
  return row.id;
}

export async function lockSupplier(tx: TenantTx, id: string) {
  const [row] = await tx
    .select({
      id: suppliers.id,
      name: suppliers.name,
      phone: suppliers.phone,
      gstin: suppliers.gstin,
      stateCode: suppliers.stateCode,
      archivedAt: suppliers.archivedAt,
      version: suppliers.version,
    })
    .from(suppliers)
    .where(eq(suppliers.id, id))
    .for("update");
  return row;
}

export async function updateSupplier(
  tx: TenantTx,
  row: { id: string; version: number },
  values: Partial<SupplierValues> & { archivedAt?: Date | null },
): Promise<void> {
  await tx
    .update(suppliers)
    .set({ ...values, version: row.version + 1 })
    .where(eq(suppliers.id, row.id));
}

const balance = sql<string>`coalesce((SELECT sum(e.amount_paise) FROM party_ledger_entries e WHERE e.supplier_id = suppliers.id), 0)::text`;

export async function listSuppliers(tx: TenantTx, filter: { includeArchived: boolean; q: string | null }) {
  const conditions = [];
  if (!filter.includeArchived) conditions.push(sql`${suppliers.archivedAt} IS NULL`);
  if (filter.q !== null) {
    const pattern = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(sql`(${suppliers.name} ILIKE ${pattern} OR ${suppliers.phone} ILIKE ${pattern} OR ${suppliers.gstin} ILIKE ${pattern})`);
  }
  return tx
    .select({
      id: suppliers.id,
      name: suppliers.name,
      phone: suppliers.phone,
      gstin: suppliers.gstin,
      stateCode: suppliers.stateCode,
      archivedAt: suppliers.archivedAt,
      version: suppliers.version,
      balancePaise: balance,
    })
    .from(suppliers)
    .where(and(...conditions))
    .orderBy(sql`lower(${suppliers.name})`)
    .limit(500);
}

export async function supplierBalance(tx: TenantTx, supplierId: string): Promise<string> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${partyLedgerEntries.amountPaise}), 0)::text` })
    .from(partyLedgerEntries)
    .where(eq(partyLedgerEntries.supplierId, supplierId));
  return row?.total ?? "0";
}

export async function ledgerOf(tx: TenantTx, supplierId: string) {
  return tx
    .select({
      id: partyLedgerEntries.id,
      entryType: partyLedgerEntries.entryType,
      amountPaise: partyLedgerEntries.amountPaise,
      sourceType: partyLedgerEntries.sourceType,
      sourceId: partyLedgerEntries.sourceId,
      note: partyLedgerEntries.note,
      createdAt: partyLedgerEntries.createdAt,
    })
    .from(partyLedgerEntries)
    .where(eq(partyLedgerEntries.supplierId, supplierId))
    .orderBy(desc(partyLedgerEntries.createdAt), desc(partyLedgerEntries.id))
    .limit(500);
}

export interface LedgerEntryValues {
  supplierId: string;
  entryType: "opening" | "purchase" | "payment" | "void_reversal";
  amountPaise: number;
  sourceType: string;
  sourceId: string;
  note: string | null;
}

// false = this source already has this entry (unique key): nothing booked.
export async function insertLedgerEntry(tx: TenantTx, ctx: TenantContext, values: LedgerEntryValues): Promise<boolean> {
  const rows = await tx
    .insert(partyLedgerEntries)
    .values({ tenantId: ctx.tenantId, createdBy: ctx.userId, ...values })
    .onConflictDoNothing({ target: [partyLedgerEntries.tenantId, partyLedgerEntries.sourceType, partyLedgerEntries.sourceId, partyLedgerEntries.entryType] })
    .returning({ id: partyLedgerEntries.id });
  return rows.length > 0;
}

export async function addAuditEntry(
  tx: TenantTx,
  ctx: TenantContext,
  entry: { action: string; entityType: string; entityId: string; before: object | null; after: object | null },
): Promise<void> {
  const [role] = await tx
    .select({ name: roles.name })
    .from(memberships)
    .innerJoin(roles, and(eq(roles.tenantId, memberships.tenantId), eq(roles.id, memberships.roleId)))
    .where(eq(memberships.userId, ctx.userId));
  await tx.insert(auditLogs).values({ tenantId: ctx.tenantId, actorUserId: ctx.userId, actorRole: role?.name ?? "unknown", ...entry });
}
