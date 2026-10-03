import "server-only";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { hasPermission, requirePermission } from "@/modules/auth";
import { findVariantsByCode, variantsForSale } from "@/modules/catalog";
import { getStockLevels } from "@/modules/inventory";
import { pickTaxRate, taxRatesFor, type TaxRateRow } from "@/modules/tax";
import * as repo from "./repo";

// What the till screen needs to show a live bill (business rules 3.6): the
// business's pricing settings and each item's price and GST rate today. The
// screen's totals are only a preview; createSale recomputes everything and
// refuses if the total it shows differs (expectedPayablePaise).

export interface PosSetupDto {
  ready: boolean; // false: state or GST registration not set yet
  pricesIncludeTax: boolean;
  chargesGst: boolean;
  stateCode: string | null;
  // null: no limit ("Discount above limit"); else basis points (500 = 5%).
  discountLimitBps: number | null;
}

export interface PosItemDto {
  variantId: string;
  name: string; // "Cotton Shirt · M / Blue"
  sku: string;
  unitCode: string;
  allowsFraction: boolean;
  trackSerial: boolean;
  pricePaise: number;
  taxRate: string; // at the full price per piece (a slab may differ after a discount)
  taxLabel: string;
  inStock: string; // in the chosen branch
}

const todayIn = (timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export async function getPosSetup(ctx: TenantContext): Promise<PosSetupDto> {
  await requirePermission(ctx, "sales.create");
  const unlimited = await hasPermission(ctx, "discounts.above_limit");
  const s = await withTenant(ctx, (tx) => repo.saleSettings(tx));
  return {
    ready: s !== undefined && s.gstRegistration !== null && s.stateCode !== null,
    pricesIncludeTax: s?.pricesIncludeTax ?? true,
    chargesGst: s?.gstRegistration === "registered",
    stateCode: s?.stateCode ?? null,
    discountLimitBps: unlimited ? null : (s?.cashierDiscountLimitBps ?? 0),
  };
}

export const priceItemsInput = z.strictObject({
  branchId: z.uuid(),
  // Exactly one of the two: what was scanned/typed, or items picked from a search.
  codes: z.array(z.string().trim().regex(/^[A-Za-z0-9._/-]{1,64}$/)).max(20).default([]),
  variantIds: z.array(z.uuid()).max(50).default([]),
});

// code (as typed) or variant id -> the item, priced for today. Unknown and
// archived items are left out.
export async function priceItemsForSale(ctx: TenantContext, rawInput: unknown): Promise<Map<string, PosItemDto>> {
  await requirePermission(ctx, "sales.create");
  const input = priceItemsInput.parse(rawInput);
  const byCode = await findVariantsByCode(ctx, { codes: input.codes });
  const wanted = new Map<string, string>([...[...byCode].map(([code, v]): [string, string] => [code, v.variantId]), ...input.variantIds.map((id): [string, string] => [id, id])]);
  if (wanted.size === 0) return new Map();
  const variantIds = [...new Set(wanted.values())];
  const levels = await getStockLevels(ctx, { variantIds });
  return withTenant(ctx, async (tx) => {
    const settings = await repo.saleSettings(tx);
    const today = todayIn(settings?.timeZone ?? "Asia/Kolkata");
    const chargesGst = settings?.gstRegistration === "registered";
    const items = await variantsForSale(tx, variantIds);
    const rates = chargesGst ? await taxRatesFor(tx, [...new Set([...items.values()].map((i) => i.taxCategory))]) : new Map<string, TaxRateRow[]>();
    const result = new Map<string, PosItemDto>();
    for (const [key, variantId] of wanted) {
      const item = items.get(variantId);
      if (item === undefined || !item.active) continue;
      let rate = { label: "No GST (bill of supply)", rate: "0" };
      if (chargesGst) {
        try {
          rate = pickTaxRate(rates.get(item.taxCategory) ?? [], item.taxCategory, today, item.sellingPricePaise);
        } catch {
          continue; // no usable rate: createSale would refuse it too
        }
      }
      result.set(key, {
        variantId,
        name: item.variantLabel === "" ? item.productName : `${item.productName} · ${item.variantLabel}`,
        sku: item.sku,
        unitCode: item.unitCode,
        allowsFraction: item.allowsFraction,
        trackSerial: item.trackSerial,
        pricePaise: item.sellingPricePaise,
        taxRate: rate.rate,
        taxLabel: rate.label,
        inStock: levels.find((l) => l.variantId === variantId && l.branchId === input.branchId)?.quantity ?? "0.000",
      });
    }
    return result;
  });
}
