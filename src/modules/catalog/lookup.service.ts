import "server-only";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { requirePermission, type Permission } from "@/modules/auth";
import * as repo from "./repo";
import { orderedAttributes, variantLabel } from "./templates";

// Item lookups for the stock, purchase and (later) billing screens: find
// items by SKU or barcode, and describe items by id. Names and units only;
// no prices or costs.

const VIEW: readonly Permission[] = ["products.manage", "sales.create", "reports.view", "stock.adjust", "purchases.create"];
const CODE = /^[A-Za-z0-9._/-]{1,64}$/;

export interface VariantSummaryDto {
  variantId: string;
  productId: string;
  // "Cotton shirt · M / Blue"
  name: string;
  sku: string;
  trackSerial: boolean;
  unitCode: string;
  allowsFraction: boolean;
  active: boolean;
}

type Row = Awaited<ReturnType<typeof repo.variantSummaries>>[number];

function toDto(row: Row, template: "clothing" | "mobile"): VariantSummaryDto {
  const label = variantLabel(orderedAttributes(template, "variant", row.attributes));
  return {
    variantId: row.variantId,
    productId: row.productId,
    name: label === "" ? row.productName : `${row.productName} · ${label}`,
    sku: row.sku,
    trackSerial: row.trackSerial,
    unitCode: row.unitCode,
    allowsFraction: row.allowsFraction,
    active: row.active,
  };
}

// code (as typed) -> the item; codes that match nothing are left out.
export async function findVariantsByCode(ctx: TenantContext, rawInput: unknown): Promise<Map<string, VariantSummaryDto>> {
  await requirePermission(ctx, VIEW);
  const { codes } = z.strictObject({ codes: z.array(z.string().trim().regex(CODE)).max(200) }).parse(rawInput);
  if (codes.length === 0) return new Map();
  return withTenant(ctx, async (tx) => {
    const rows = await repo.variantSummaries(tx, { codes });
    const template = await repo.businessTemplate(tx);
    const found = new Map<string, VariantSummaryDto>();
    for (const code of codes) {
      // A barcode is exact; a SKU ignores case. Barcode wins if both match.
      const row = rows.find((r) => r.barcodes.includes(code)) ?? rows.find((r) => r.sku.toUpperCase() === code.toUpperCase());
      if (row !== undefined) found.set(code, toDto(row, template));
    }
    return found;
  });
}

export async function describeVariants(ctx: TenantContext, rawInput: unknown): Promise<Map<string, VariantSummaryDto>> {
  await requirePermission(ctx, VIEW);
  const { variantIds } = z.strictObject({ variantIds: z.array(z.uuid()).max(1000) }).parse(rawInput);
  if (variantIds.length === 0) return new Map();
  return withTenant(ctx, async (tx) => {
    const rows = await repo.variantSummaries(tx, { ids: [...new Set(variantIds)] });
    const template = await repo.businessTemplate(tx);
    return new Map(rows.map((r) => [r.variantId, toDto(r, template)]));
  });
}
