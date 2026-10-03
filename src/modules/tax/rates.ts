import type { TenantTx } from "@/db/with-tenant";
import * as repo from "./repo";

// Choosing the GST rate for an item (business rules 4.1, 4.2; open
// questions 1 and 2). Pure: the caller passes the rate rows of the item's
// tax category. A row applies when the day is inside its dates
// (from inclusive, to exclusive) and the price per piece is inside its
// range (min inclusive, max exclusive). Exactly one row must apply; none or
// several is a data problem the accountant must fix, never a guess.

export interface TaxRateRow {
  label: string;
  rate: string; // "5.0000"
  priceMinPaise: number | null;
  priceMaxPaise: number | null;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null;
}

export class TaxRateError extends Error {
  constructor(
    public readonly code: "NO_RATE" | "SEVERAL_RATES",
    public readonly taxCategory: string,
  ) {
    super(code === "NO_RATE" ? `No GST rate is set for this item's tax category (${taxCategory}).` : `More than one GST rate matches (${taxCategory}). Ask the accountant to check the rates.`);
    this.name = "TaxRateError";
  }
}

export function pickTaxRate(rows: TaxRateRow[], taxCategory: string, onDay: string, pricePerPiecePaise: number): TaxRateRow {
  const matches = rows.filter(
    (r) =>
      r.effectiveFrom <= onDay &&
      (r.effectiveTo === null || onDay < r.effectiveTo) &&
      (r.priceMinPaise === null || pricePerPiecePaise >= r.priceMinPaise) &&
      (r.priceMaxPaise === null || pricePerPiecePaise < r.priceMaxPaise),
  );
  const [only, ...rest] = matches;
  if (only === undefined) throw new TaxRateError("NO_RATE", taxCategory);
  if (rest.length > 0) throw new TaxRateError("SEVERAL_RATES", taxCategory);
  return only;
}

// The rate rows of each tax category, for pickTaxRate. Inside the caller's
// transaction (a TenantTx exists only inside withTenant).
export async function taxRatesFor(tx: TenantTx, categories: string[]): Promise<Map<string, TaxRateRow[]>> {
  const rows = await repo.ratesOf(tx, [...new Set(categories)]);
  const byCategory = new Map<string, TaxRateRow[]>();
  for (const { taxCategory, ...row } of rows) byCategory.set(taxCategory, [...(byCategory.get(taxCategory) ?? []), row]);
  return byCategory;
}
