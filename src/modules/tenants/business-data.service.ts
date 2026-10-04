import "server-only";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { requirePermission, PERMISSIONS } from "@/modules/auth";
import * as repo from "./repo";

// The owner's own data (Phase 11; OWASP ASVS 8.3.2): a full export, and a
// request to delete the business. Both need "Delete business or transfer
// ownership" (Owner only) and are audited.
//
// Deletion: the business keeps working for DELETION_GRACE_DAYS (time to
// export and to change one's mind; anyone can see the date), then nobody
// can enter it (auth/repo.ts), and an operator removes its data with
// scripts/purge-business.ts. Bills must normally be kept for years for GST:
// the owner is told to export first (open question 50).

export const DELETION_GRACE_DAYS = 30;
const EXPORT_EVERY_MS = 10 * 60_000;

export class BusinessDataError extends Error {
  constructor(public readonly code: "NAME_MISMATCH" | "ALREADY_REQUESTED" | "NOT_REQUESTED" | "EXPORT_TOO_SOON") {
    super(
      code === "NAME_MISMATCH"
        ? "Type the business name exactly as shown to confirm."
        : code === "ALREADY_REQUESTED"
          ? "Deletion was already requested."
          : code === "NOT_REQUESTED"
            ? "No deletion was requested."
            : "An export was made a few minutes ago. Please wait 10 minutes between exports.",
    );
    this.name = "BusinessDataError";
  }
}

export const requestDeletionInput = z.strictObject({ confirmName: z.string().trim().min(1, { error: "Type the business name to confirm." }).max(200) });

export interface BusinessDeletionDto {
  requestedAt: string | null;
  dueAt: string | null;
}

export interface BusinessExport {
  fileName: string;
  // file name inside the archive -> rows (first row: column names)
  files: Map<string, (string | number)[][]>;
}

const cell = (value: unknown): string | number => {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
};

function sheet(rows: Record<string, unknown>[]): (string | number)[][] {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [columns, ...rows.map((r) => columns.map((c) => cell(r[c])))];
}

export async function exportBusinessData(ctx: TenantContext): Promise<BusinessExport> {
  await requirePermission(ctx, "business.delete");
  return withTenant(ctx, async (tx) => {
    const last = await repo.lastExportAt(tx);
    if (last !== null && Date.now() - new Date(last).getTime() < EXPORT_EVERY_MS) throw new BusinessDataError("EXPORT_TOO_SOON");
    const business = await repo.businessRow(tx);
    const files = new Map<string, (string | number)[][]>();
    files.set("business.csv", sheet(business === undefined ? [] : [business]));
    files.set("people.csv", sheet(await repo.businessPeople(tx)));
    const counts: Record<string, number> = {};
    for (const table of repo.EXPORT_TABLES) {
      const rows = await repo.exportTable(tx, table);
      counts[table] = rows.length;
      files.set(`${table}.csv`, sheet(rows));
    }
    await repo.addAuditEntry(tx, ctx, {
      actorRole: await repo.actorRoleName(tx, ctx),
      action: "business.exported",
      entityType: "tenant",
      entityId: ctx.tenantId,
      before: {},
      after: { tables: repo.EXPORT_TABLES.length, rows: counts },
    });
    const day = new Date().toISOString().slice(0, 10);
    return { fileName: `business-export-${day}.zip`, files };
  });
}

export async function getBusinessDeletion(ctx: TenantContext): Promise<BusinessDeletionDto> {
  // Every member sees the date (a banner), whatever their role.
  await requirePermission(ctx, PERMISSIONS);
  const row = await withTenant(ctx, (tx) => repo.businessRow(tx));
  return { requestedAt: row?.deletionRequestedAt?.toISOString() ?? null, dueAt: row?.deletionDueAt?.toISOString() ?? null };
}

export async function requestBusinessDeletion(ctx: TenantContext, rawInput: unknown): Promise<BusinessDeletionDto> {
  await requirePermission(ctx, "business.delete");
  const { confirmName } = requestDeletionInput.parse(rawInput);
  return withTenant(ctx, async (tx) => {
    const business = await repo.businessRow(tx);
    if (business === undefined || confirmName !== business.name) throw new BusinessDataError("NAME_MISMATCH");
    if (business.deletionDueAt !== null) throw new BusinessDataError("ALREADY_REQUESTED");
    const requestedAt = new Date();
    const dueAt = new Date(requestedAt.getTime() + DELETION_GRACE_DAYS * 86_400_000);
    await repo.setDeletion(tx, ctx, { requestedAt, dueAt });
    await repo.addAuditEntry(tx, ctx, {
      actorRole: await repo.actorRoleName(tx, ctx),
      action: "business.deletion_requested",
      entityType: "tenant",
      entityId: ctx.tenantId,
      before: {},
      after: { dueAt: dueAt.toISOString() },
    });
    return { requestedAt: requestedAt.toISOString(), dueAt: dueAt.toISOString() };
  });
}

export async function cancelBusinessDeletion(ctx: TenantContext): Promise<void> {
  await requirePermission(ctx, "business.delete");
  await withTenant(ctx, async (tx) => {
    const business = await repo.businessRow(tx);
    if (business === undefined || business.deletionDueAt === null) throw new BusinessDataError("NOT_REQUESTED");
    await repo.setDeletion(tx, ctx, null);
    await repo.addAuditEntry(tx, ctx, {
      actorRole: await repo.actorRoleName(tx, ctx),
      action: "business.deletion_cancelled",
      entityType: "tenant",
      entityId: ctx.tenantId,
      before: { dueAt: business.deletionDueAt.toISOString() },
      after: {},
    });
  });
}
