import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArchiveButton, BarcodeForms, PriceForm } from "@/components/forms/variant-forms";
import { NotAllowed } from "@/components/not-allowed";
import { formatPaise, paiseToRupeesText } from "@/lib/money";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { getProduct, ProductError, type ProductDto } from "@/modules/catalog";
import { archiveAction, barcodeAction, changePriceAction } from "@/app/(app)/catalog/products/actions";

export const metadata: Metadata = { title: "Product" };

export default async function ProductPage({ params }: PageProps<"/catalog/products/[id]">) {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  const { id } = await params;
  let product: ProductDto;
  try {
    product = await getProduct(who.ctx, id);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    if (error instanceof ProductError || (error instanceof Error && error.name === "ZodError")) notFound();
    throw error;
  }
  const canPrice = who.permissions.includes("prices.change");
  const canManage = who.permissions.includes("products.manage");
  const showCost = product.variants.some((v) => "costPricePaise" in v);
  return (
    <main className="flex max-w-4xl flex-col gap-4">
      <Link href="/catalog/products" className="text-sm underline">← Products</Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {product.name}
          {product.active ? "" : " (archived)"}
        </h1>
        {canManage ? <ArchiveButton kind="product" id={product.id} productId={product.id} active={product.active} action={archiveAction} /> : null}
      </div>
      <p className="text-sm text-muted-foreground">
        HSN {product.hsnCode ?? "—"} · tax {product.taxCategory}
        {product.trackSerial ? " · tracked by IMEI/serial" : ""}
        {product.warrantyMonths !== null ? ` · warranty ${String(product.warrantyMonths)} months` : ""}
        {product.attributes.model !== undefined ? ` · model ${product.attributes.model}` : ""}
      </p>
      <ul className="flex flex-col divide-y rounded-lg border" aria-label="Variants">
        {product.variants.map((v) => (
          <li key={`${v.id}-${String(v.version)}`} className="flex flex-col gap-2 p-3" aria-label={v.sku}>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                <span className="font-medium">{v.sku}</span> {v.label === "" ? "" : `· ${v.label}`} · {formatPaise(v.sellingPricePaise)}
                {v.mrpPaise !== null ? ` (MRP ${formatPaise(v.mrpPaise)})` : ""}
                {"costPricePaise" in v && v.costPricePaise !== null && v.costPricePaise !== undefined ? ` · cost ${formatPaise(v.costPricePaise)}` : ""}
                {v.active ? "" : " · archived"}
              </span>
              {canManage ? <ArchiveButton kind="variant" id={v.id} productId={product.id} active={v.active} action={archiveAction} /> : null}
            </div>
            {canManage ? (
              <BarcodeForms productId={product.id} variantId={v.id} barcodes={v.barcodes} action={barcodeAction} />
            ) : v.barcodes.length > 0 ? (
              <p className="text-xs text-muted-foreground">Barcodes: {v.barcodes.map((b) => b.code).join(", ")}</p>
            ) : null}
            {canPrice ? (
              <PriceForm
                productId={product.id}
                showCost={showCost}
                action={changePriceAction}
                variant={{
                  id: v.id,
                  version: v.version,
                  label: v.label === "" ? v.sku : v.label,
                  price: paiseToRupeesText(v.sellingPricePaise),
                  mrp: v.mrpPaise === null ? "" : paiseToRupeesText(v.mrpPaise),
                  ...(showCost ? { cost: v.costPricePaise === null || v.costPricePaise === undefined ? "" : paiseToRupeesText(v.costPricePaise) } : {}),
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  );
}
