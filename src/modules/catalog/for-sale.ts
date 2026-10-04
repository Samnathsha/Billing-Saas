import "server-only";
import type { TenantTx } from "@/db/with-tenant";
import * as repo from "./repo";
import { orderedAttributes, variantLabel } from "./templates";

// Inside-the-transaction lookup for the sale service (sales module), like
// postMovements: it runs only inside withTenant, after the caller checked
// permissions. Prices come from here, never from the browser (rule 3.6).

export interface VariantForSale {
  variantId: string;
  productName: string;
  variantLabel: string;
  sku: string;
  hsnCode: string | null;
  unitCode: string;
  allowsFraction: boolean;
  trackSerial: boolean;
  warrantyMonths: number | null;
  taxCategory: string;
  sellingPricePaise: number;
  active: boolean;
}

export async function variantsForSale(tx: TenantTx, variantIds: string[]): Promise<Map<string, VariantForSale>> {
  const rows = await repo.variantsForSale(tx, [...new Set(variantIds)]);
  const template = await repo.businessTemplate(tx);
  return new Map(
    rows.map((r) => [
      r.variantId,
      {
        variantId: r.variantId,
        productName: r.productName,
        variantLabel: variantLabel(orderedAttributes(template, "variant", r.attributes)),
        sku: r.sku,
        hsnCode: r.hsnCode,
        unitCode: r.unitCode,
        allowsFraction: r.allowsFraction,
        trackSerial: r.trackSerial,
        warrantyMonths: r.warrantyMonths,
        taxCategory: r.taxCategory,
        sellingPricePaise: r.sellingPricePaise,
        active: r.active,
      },
    ]),
  );
}

// A till's offline copy of the catalog (decision 0006): every sellable item
// with its selling price, tax category and the codes it is scanned by (SKU
// and barcodes). Never cost prices (blueprint 8.5).
export const TILL_CATALOG_LIMIT = 20_000;

export async function catalogForTill(tx: TenantTx): Promise<(VariantForSale & { codes: string[] })[]> {
  const ids = await repo.activeVariantIds(tx, TILL_CATALOG_LIMIT);
  const items = await variantsForSale(tx, ids);
  const codes = new Map<string, string[]>();
  for (const b of await repo.allActiveBarcodes(tx)) codes.set(b.variantId, [...(codes.get(b.variantId) ?? []), b.code]);
  return [...items.values()].map((item) => ({ ...item, codes: [item.sku, ...(codes.get(item.variantId) ?? [])] }));
}
