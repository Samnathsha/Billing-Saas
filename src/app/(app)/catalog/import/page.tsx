import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ImportForm } from "@/components/forms/import-form";
import { NotAllowed } from "@/components/not-allowed";
import { getRequestContext } from "@/modules/auth";
import { importAction } from "./actions";

export const metadata: Metadata = { title: "Import products" };

// Manage products and Change a selling price (the import checks both).
export default async function ImportPage() {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  if (!who.permissions.includes("products.manage") || !who.permissions.includes("prices.change")) return <NotAllowed />;
  return (
    <main className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Import products from CSV</h1>
      <div className="flex flex-col gap-2 text-sm text-muted-foreground">
        <p>
          One line per variant; lines with the same product name become one product. Every line is checked first: if any
          line has a problem, nothing is imported and each problem is listed with its line number.
        </p>
        <p>
          Required columns: <code>product_name, unit, tax, sku, selling_price</code>. Optional: <code>category, brand, hsn,
          size, colour, fabric, model, ram, storage, warranty_months, track_imei, mrp, cost, reorder_level, barcode</code>.
          Prices in rupees (e.g. 799.50). Unit is the unit code (e.g. pcs); tax is the rate name (e.g. TEST 5%).
          Categories, brands and units must already exist.
        </p>
      </div>
      <ImportForm action={importAction} />
    </main>
  );
}
