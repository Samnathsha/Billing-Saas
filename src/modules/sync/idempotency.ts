import "server-only";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import * as repo from "./repo";

// Idempotency for money and stock writes (CLAUDE.md). The caller decides
// the result up front (e.g. a freshly generated purchase id) and claims the
// key FIRST, inside its transaction:
// - claimed: do the work; the key and the work commit together;
// - already used: a retry (or double click) of the same operation; return
//   the stored result and do nothing. A second attempt that arrives while
//   the first is still running waits for it (the database holds the key).
// A rolled-back attempt leaves no key behind, so it can be retried.

export class IdempotencyError extends Error {
  constructor() {
    super("This request key was already used for something else.");
    this.name = "IdempotencyError";
  }
}

export async function claimIdempotencyKey<T extends object>(
  tx: TenantTx,
  ctx: TenantContext,
  key: string,
  operation: string,
  result: T,
): Promise<{ claimed: true } | { claimed: false; result: T }> {
  if (await repo.claimKey(tx, ctx, key, operation, result)) return { claimed: true };
  const existing = await repo.findKey(tx, key);
  if (existing === undefined || existing.operation !== operation) throw new IdempotencyError();
  return { claimed: false, result: existing.result as T };
}
