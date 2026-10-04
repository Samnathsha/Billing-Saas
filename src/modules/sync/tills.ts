import "server-only";
import { createHash } from "node:crypto";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { TillError } from "./errors";
import * as repo from "./repo";

// Inside-the-transaction helpers for the offline sync (sales module), like
// claimIdempotencyKey: they run only inside withTenant, after the caller
// checked permissions (decision 0006).

// A till's token is 32 random bytes; only its SHA-256 is stored. A plain
// hash is enough for a random secret of this size (no password guessing).
export const hashTillToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

export interface ActiveTill {
  id: string;
  name: string;
  prefix: string;
  branchId: string;
  branchName: string;
  registeredAt: Date;
}

// The till that sent this token, in this business (row-level security),
// locked for the rest of the transaction. Unknown and revoked tills are
// refused.
export async function lockActiveTill(tx: TenantTx, token: string): Promise<ActiveTill> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new TillError("TILL_UNKNOWN");
  const till = await repo.lockTillByTokenHash(tx, hashTillToken(token));
  if (till === undefined || till.prefix === null) throw new TillError("TILL_UNKNOWN");
  if (till.status !== "active") throw new TillError("TILL_REVOKED");
  await repo.touchTill(tx, till.id);
  return { id: till.id, name: till.name, prefix: till.prefix, branchId: till.branchId, branchName: till.branchName, registeredAt: till.createdAt };
}

// A till operation runs at most once. The caller holds the till's lock
// (lockActiveTill), so this till's operations run one after another: look
// for an earlier result first (a repeat after a lost answer or a crash gets
// it back and changes nothing), else do the work and record the result in
// the same transaction.
export async function earlierTillResult(tx: TenantTx, deviceId: string, clientOpId: string, operation: string): Promise<object | undefined> {
  const existing = await repo.findOperation(tx, deviceId, clientOpId);
  if (existing === undefined) return undefined;
  if (existing.operation !== operation) throw new TillError("OP_ID_REUSED");
  return existing.result ?? {};
}

export async function recordTillOperation(
  tx: TenantTx,
  ctx: TenantContext,
  op: { deviceId: string; clientOpId: string; operation: string; status: "applied" | "flagged"; result: object },
): Promise<void> {
  if (!(await repo.claimOperation(tx, ctx, op))) throw new TillError("OP_ID_REUSED");
}

export type { NewFlag } from "./repo";

export async function recordFlags(tx: TenantTx, ctx: TenantContext, flags: repo.NewFlag[]): Promise<void> {
  await repo.insertFlags(tx, ctx, flags);
}

export async function addTillAudit(
  tx: TenantTx,
  ctx: TenantContext,
  entry: { action: string; entityType: string; entityId: string; after: object; deviceId: string },
): Promise<void> {
  await repo.addAuditEntry(tx, ctx, { ...entry, before: null });
}
