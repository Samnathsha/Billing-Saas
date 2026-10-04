import type { TenantTx } from "@/db/with-tenant";
import { type TaxRateRow } from "@/lib/tax-pick";
import * as repo from "./repo";

// The rule itself is pure and lives in src/lib/tax-pick.ts, so the offline
// till (decision 0006) picks rates exactly as the server does.
export { pickTaxRate, TaxRateError, type TaxRateRow } from "@/lib/tax-pick";

// The rate rows of each tax category, for pickTaxRate. Inside the caller's
// transaction (a TenantTx exists only inside withTenant).
export async function taxRatesFor(tx: TenantTx, categories: string[]): Promise<Map<string, TaxRateRow[]>> {
  const rows = await repo.ratesOf(tx, [...new Set(categories)]);
  const byCategory = new Map<string, TaxRateRow[]>();
  for (const { taxCategory, ...row } of rows) byCategory.set(taxCategory, [...(byCategory.get(taxCategory) ?? []), row]);
  return byCategory;
}
