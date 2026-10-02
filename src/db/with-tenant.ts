import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Database } from "./client";

// Blueprint 5.1, layer 2: all business data is reached through
// withTenant(ctx, fn). It opens a transaction and sets the business and user
// for that transaction only (set_config(..., true)), so a pooled connection
// never carries one request's tenant into the next. Row-level security in
// the database then limits every query to that business.

declare const tenantContextBrand: unique symbol;
declare const tenantTxBrand: unique symbol;

// Who is acting, and for which business. "Sealed": TypeScript only accepts a
// value made by createTenantContext(), never a hand-written object, so the
// tenant cannot come from request data by accident. Only the session code
// (Phase 3) calls createTenantContext, after checking the membership.
export interface TenantContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly [tenantContextBrand]: true;
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// A database handle that only exists inside withTenant. Repositories take
// this type, so they cannot be called with the raw database.
export type TenantTx = Transaction & { readonly [tenantTxBrand]: true };

const contextInput = z.strictObject({
  tenantId: z.uuid(),
  userId: z.uuid(),
});

export function createTenantContext(input: { tenantId: string; userId: string }): TenantContext {
  const parsed = contextInput.parse(input);
  return Object.freeze(parsed) as TenantContext;
}

export async function withTenant<T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  // Re-checked here as well: a forged object cast past the type system still
  // cannot inject anything but a valid UUID.
  const { tenantId, userId } = contextInput.parse({ tenantId: ctx.tenantId, userId: ctx.userId });

  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId}, true)`,
    );
    return fn(tx as TenantTx);
  });
}
