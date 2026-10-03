import "server-only";
import { sql } from "drizzle-orm";
import type { TenantContext, TenantTx } from "@/db/with-tenant";

// Database queries of the sales module, inside the caller's transaction.

// Creates the series at 1, or adds 1 while below `max`. The row stays
// locked until the transaction ends. undefined = the series is full.
export async function incrementSequence(
  tx: TenantTx,
  ctx: TenantContext,
  series: { kind: string; prefix: string; financialYear: string },
  max: number,
): Promise<number | undefined> {
  const result = await tx.execute<{ last_number: number }>(sql`
    INSERT INTO invoice_sequences (tenant_id, series, prefix, financial_year, last_number, created_by)
    VALUES (${ctx.tenantId}, ${series.kind}, ${series.prefix}, ${series.financialYear}, 1, ${ctx.userId})
    ON CONFLICT (tenant_id, series, prefix, financial_year)
    DO UPDATE SET last_number = invoice_sequences.last_number + 1,
                  version = invoice_sequences.version + 1,
                  updated_at = now()
    WHERE invoice_sequences.last_number < ${max}
    RETURNING last_number`);
  return result.rows[0]?.last_number;
}
