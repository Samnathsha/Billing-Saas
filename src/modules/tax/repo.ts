import "server-only";
import { inArray } from "drizzle-orm";
import type { TenantTx } from "@/db/with-tenant";
import { taxRates } from "@/db/schema";

// Database queries of the tax module (global, read-only rows).

export async function ratesOf(tx: TenantTx, categories: string[]) {
  if (categories.length === 0) return [];
  return tx
    .select({
      taxCategory: taxRates.taxCategory,
      label: taxRates.label,
      rate: taxRates.rate,
      priceMinPaise: taxRates.priceMinPaise,
      priceMaxPaise: taxRates.priceMaxPaise,
      effectiveFrom: taxRates.effectiveFrom,
      effectiveTo: taxRates.effectiveTo,
    })
    .from(taxRates)
    .where(inArray(taxRates.taxCategory, categories));
}
