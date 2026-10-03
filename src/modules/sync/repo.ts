import "server-only";
import { and, eq } from "drizzle-orm";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { idempotencyKeys } from "@/db/schema";

export async function claimKey(tx: TenantTx, ctx: TenantContext, key: string, operation: string, result: object): Promise<boolean> {
  const rows = await tx
    .insert(idempotencyKeys)
    .values({ tenantId: ctx.tenantId, key, operation, result })
    .onConflictDoNothing({ target: [idempotencyKeys.tenantId, idempotencyKeys.key] })
    .returning({ id: idempotencyKeys.id });
  return rows.length > 0;
}

export async function findKey(tx: TenantTx, key: string) {
  const [row] = await tx
    .select({ operation: idempotencyKeys.operation, result: idempotencyKeys.result })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.key, key)));
  return row;
}
