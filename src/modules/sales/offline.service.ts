import "server-only";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { colleagueContext, hasPermission, requirePermission } from "@/modules/auth";
import { addTillAudit, earlierTillResult, lockActiveTill, recordFlags, recordTillOperation } from "@/modules/sync";
import { SalesError } from "./errors";
import { applyOfflineReturn, applyOfflineSale, buildTillSnapshot, offlineOperation, type TillSnapshotDto } from "./offline-core";

// The server side of offline tills (decision 0006). Both calls need the
// logged-in session (the business comes ONLY from it) AND the till's token
// (a registered, not revoked till of that business).

export interface OfflineResultDto {
  kind: "sale" | "return";
  // The bill's or credit note's id and number.
  id: string;
  number: string;
  // Flag codes recorded for a manager (empty: all fine).
  flags: string[];
  // true: this operation had already been applied; nothing changed now.
  repeat: boolean;
}

// One offline operation, in its own transaction. Allowed for whoever may
// sell or manage tills now; the operation itself is checked against the
// CURRENT role of the person who made it (kept and flagged if it lapsed,
// business rules 17).
export async function applyOfflineOperation(ctx: TenantContext, tillToken: string, rawOp: unknown): Promise<OfflineResultDto> {
  await requirePermission(ctx, ["sales.create", "tills.manage"]);
  const op = offlineOperation.parse(rawOp);
  const sellerCtx = await colleagueContext(ctx, op.madeBy);
  if (sellerCtx === undefined) throw new SalesError("OFFLINE_UNKNOWN_SELLER");
  const [canSell, unlimitedDiscount, mayPassWindow] = await Promise.all([
    hasPermission(sellerCtx, "sales.create"),
    hasPermission(sellerCtx, "discounts.above_limit"),
    hasPermission(sellerCtx, "invoices.void"),
  ]);
  const seller = { ctx: sellerCtx, canSell, unlimitedDiscount, mayPassWindow };
  const operation = op.kind === "sale" ? "sales.offline_sale" : "sales.offline_return";

  return withTenant(ctx, async (tx) => {
    const till = await lockActiveTill(tx, tillToken);
    const earlier = await earlierTillResult(tx, till.id, op.opId, operation);
    if (earlier !== undefined) return { ...(earlier as Omit<OfflineResultDto, "repeat">), repeat: true };

    const applied = op.kind === "sale" ? await applyOfflineSale(tx, ctx, till, seller, op) : await applyOfflineReturn(tx, ctx, till, seller, op);
    await recordFlags(
      tx,
      ctx,
      applied.flags.map((f) => ({ deviceId: till.id, invoiceId: op.kind === "sale" ? applied.id : null, creditNoteId: op.kind === "return" ? applied.id : null, code: f.code, detail: f.detail })),
    );
    const result = { kind: op.kind, id: applied.id, number: applied.number, flags: applied.flags.map((f) => f.code) };
    await recordTillOperation(tx, ctx, { deviceId: till.id, clientOpId: op.opId, operation, status: result.flags.length > 0 ? "flagged" : "applied", result });
    await addTillAudit(tx, ctx, {
      action: "sales.offline_synced",
      entityType: op.kind === "sale" ? "invoice" : "credit_note",
      entityId: applied.id,
      after: { number: applied.number, madeBy: op.madeBy, madeAt: op.madeAt, flags: result.flags },
      deviceId: till.id,
    });
    return { ...result, repeat: false };
  });
}

// What the till keeps for selling offline (blueprint 8.5: only what the
// role may see; never costs). Refreshing it also counts as the till's
// online contact (its offline window starts again).
export async function getTillSnapshot(ctx: TenantContext, tillToken: string): Promise<TillSnapshotDto> {
  await requirePermission(ctx, "sales.create");
  const [mayGiveAnyDiscount, mayReturnAfterWindow] = await Promise.all([hasPermission(ctx, "discounts.above_limit"), hasPermission(ctx, "invoices.void")]);
  return withTenant(ctx, async (tx) => {
    const till = await lockActiveTill(tx, tillToken);
    return buildTillSnapshot(tx, ctx, till, { mayGiveAnyDiscount, mayReturnAfterWindow });
  });
}
