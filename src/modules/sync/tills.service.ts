import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { TILL_PREFIX_PATTERN, tillCreditNotePrefix } from "@/lib/document-number";
import { requirePermission } from "@/modules/auth";
import { requireCapacity } from "@/modules/plans";
import { TillError } from "./errors";
import * as repo from "./repo";
import { SYNC_FLAG_CODES } from "./schema";
import { hashTillToken } from "./tills";

// Registered tills and the offline flags (decision 0006; business rules
// 17). A manager ("Manage tills") registers a till ON the computer that
// will be the till: the answer carries the till's token exactly once, and
// that computer keeps it in its local store. The server keeps only the
// token's hash. Revoking is final; the till is refused at its next sync.

export const registerTillInput = z.strictObject({
  name: z.string().trim().min(1, { error: "Name the till, e.g. Counter 1." }).max(100),
  branchId: z.uuid({ error: "Choose a branch." }),
  prefix: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(TILL_PREFIX_PATTERN, { error: "Use 1 to 3 letters or digits, e.g. T1." })),
});

export const offlineWindowInput = z.strictObject({
  hours: z.coerce.number({ error: "Enter a number of hours." }).int({ error: "Whole hours only." }).min(1, { error: "At least 1 hour." }).max(720, { error: "At most 720 hours (30 days)." }),
});

export const revokeTillInput = z.strictObject({ tillId: z.uuid() });

export const resolveFlagInput = z.strictObject({
  flagId: z.uuid(),
  note: z.string().trim().min(3, { error: "Say what was done (at least 3 characters)." }).max(500),
});

export interface RegisteredTillDto {
  tillId: string;
  name: string;
  prefix: string;
  branchId: string;
  branchName: string;
  // Shown to this browser once, never stored on the server.
  token: string;
}

export interface TillDto {
  id: string;
  name: string;
  branchName: string;
  prefix: string;
  status: "active" | "revoked";
  lastSeenAt: string | null;
  registeredAt: string;
  revokedAt: string | null;
}

export type SyncFlagCode = (typeof SYNC_FLAG_CODES)[number];

export interface SyncFlagDto {
  id: string;
  code: SyncFlagCode;
  detail: Record<string, string | number | null>;
  status: "open" | "resolved";
  tillName: string;
  document: { kind: "invoice"; id: string; number: string } | { kind: "credit_note"; id: string; number: string } | null;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export async function registerTill(ctx: TenantContext, rawInput: unknown): Promise<RegisteredTillDto> {
  await requirePermission(ctx, "tills.manage");
  const input = registerTillInput.parse(rawInput);
  const token = randomBytes(32).toString("base64url");
  return withTenant(ctx, async (tx) => {
    const branch = await repo.openBranch(tx, input.branchId);
    if (branch === undefined) throw new TillError("BRANCH_CLOSED");
    // The till's bills use its prefix and its credit notes the prefix + R:
    // neither may equal any other series' prefix (business or till).
    const taken = new Set([...(await repo.businessPrefixes(tx)), ...(await repo.tillPrefixes(tx)).flatMap((p) => [p, tillCreditNotePrefix(p)])]);
    if (taken.has(input.prefix) || taken.has(tillCreditNotePrefix(input.prefix))) throw new TillError("PREFIX_TAKEN");
    await requireCapacity(tx, ctx, "devices");
    const tillId = await repo.insertTill(tx, ctx, { branchId: branch.id, name: input.name, prefix: input.prefix, tokenHash: hashTillToken(token) });
    await repo.addAuditEntry(tx, ctx, { action: "tills.registered", entityType: "device", entityId: tillId, before: null, after: { name: input.name, prefix: input.prefix, branch: branch.name }, deviceId: tillId });
    return { tillId, name: input.name, prefix: input.prefix, branchId: branch.id, branchName: branch.name, token };
  });
}

export async function listTills(ctx: TenantContext): Promise<TillDto[]> {
  await requirePermission(ctx, "tills.manage");
  const rows = await withTenant(ctx, (tx) => repo.listTills(tx));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    branchName: r.branchName,
    prefix: r.prefix ?? "",
    status: r.status === "revoked" ? "revoked" : "active",
    lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
    registeredAt: r.createdAt.toISOString(),
    revokedAt: r.revokedAt?.toISOString() ?? null,
  }));
}

export async function revokeTill(ctx: TenantContext, rawInput: unknown): Promise<void> {
  await requirePermission(ctx, "tills.manage");
  const { tillId } = revokeTillInput.parse(rawInput);
  await withTenant(ctx, async (tx) => {
    const till = await repo.lockTill(tx, tillId);
    if (till === undefined || till.prefix === null) throw new TillError("NOT_FOUND");
    if (till.status === "revoked") throw new TillError("ALREADY_REVOKED");
    await repo.revokeTill(tx, ctx, tillId);
    await repo.addAuditEntry(tx, ctx, { action: "tills.revoked", entityType: "device", entityId: tillId, before: { status: "active" }, after: { status: "revoked", name: till.name, prefix: till.prefix }, deviceId: tillId });
  });
}

const flagDetail = (value: unknown): Record<string, string | number | null> => {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string | number | null] => typeof e[1] === "string" || typeof e[1] === "number" || e[1] === null));
};

export async function listSyncFlags(ctx: TenantContext, rawInput: unknown): Promise<SyncFlagDto[]> {
  await requirePermission(ctx, "tills.manage");
  const { status } = z.strictObject({ status: z.enum(["open", "resolved"]).default("open") }).parse(rawInput);
  const rows = await withTenant(ctx, (tx) => repo.listFlags(tx, status, 500));
  return rows.map((r) => ({
    id: r.id,
    code: (SYNC_FLAG_CODES as readonly string[]).includes(r.code) ? (r.code as SyncFlagCode) : "stock_short",
    detail: flagDetail(r.detail),
    status: r.status === "resolved" ? "resolved" : "open",
    tillName: r.tillName,
    document:
      r.invoiceId !== null && r.invoiceNumber !== null
        ? { kind: "invoice", id: r.invoiceId, number: r.invoiceNumber }
        : r.creditNoteId !== null && r.creditNoteNumber !== null
          ? { kind: "credit_note", id: r.creditNoteId, number: r.creditNoteNumber }
          : null,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolutionNote: r.resolutionNote,
  }));
}

export async function countOpenSyncFlags(ctx: TenantContext): Promise<number> {
  await requirePermission(ctx, "tills.manage");
  return withTenant(ctx, (tx) => repo.countOpenFlags(tx));
}

export async function resolveSyncFlag(ctx: TenantContext, rawInput: unknown): Promise<void> {
  await requirePermission(ctx, "tills.manage");
  const input = resolveFlagInput.parse(rawInput);
  await withTenant(ctx, async (tx) => {
    const flag = await repo.lockFlag(tx, input.flagId);
    if (flag === undefined) throw new TillError("NOT_FOUND");
    if (flag.status !== "open") throw new TillError("FLAG_RESOLVED");
    await repo.resolveFlag(tx, ctx, flag.id, input.note);
    await repo.addAuditEntry(tx, ctx, { action: "tills.flag_resolved", entityType: "sync_flag", entityId: flag.id, before: { status: "open" }, after: { status: "resolved", code: flag.code, note: input.note } });
  });
}

// How long a till may sell offline after its last online contact (business
// rules 17, default 72 hours).
export async function getOfflineWindowHours(ctx: TenantContext): Promise<number> {
  await requirePermission(ctx, ["tills.manage", "settings.manage"]);
  return withTenant(ctx, (tx) => repo.offlineWindowHours(tx));
}

export async function setOfflineWindowHours(ctx: TenantContext, rawInput: unknown): Promise<void> {
  await requirePermission(ctx, "settings.manage");
  const { hours } = offlineWindowInput.parse(rawInput);
  await withTenant(ctx, async (tx) => {
    const before = await repo.offlineWindowHours(tx);
    if (before === hours) return;
    await repo.setOfflineWindowHours(tx, hours);
    await repo.addAuditEntry(tx, ctx, { action: "settings.offline_window_changed", entityType: "settings", entityId: ctx.tenantId, before: { hours: before }, after: { hours } });
  });
}
