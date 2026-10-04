import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { settings } from "@/db/schema";
import { withTenant } from "@/db/with-tenant";
import { createBusiness, getRequestContext } from "@/modules/auth";
import { createProduct, getCatalogLists } from "@/modules/catalog";
import { getDashboard, getPaymentsReport, getProfitReport, getSalesBreakdown, getSalesReport, getTaxSummary } from "@/modules/reports";
import { listBranches } from "@/modules/tenants";
import { registerVerifiedUser } from "../helpers/auth";

// Blueprint Phase 9: report speed with 50,000 bills (3 lines each), spread
// over the last 365 days. Run with `npm run test:perf` against the LOCAL
// database; the numbers are written to docs/decisions/0005.

const BILLS = 50_000;

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function timed<T>(label: string, work: () => Promise<T>): Promise<{ label: string; ms: number; result: T }> {
  const start = performance.now();
  const result = await work();
  return { label, ms: Math.round(performance.now() - start), result };
}

describe("report speed", () => {
  it(`reports over ${String(BILLS)} bills answer in a few seconds`, async () => {
    if (!(process.env.DATABASE_URL_TEST ?? "").includes("localhost")) throw new Error("Run the speed check against the local database only.");
    const owner = await registerVerifiedUser("Perf Owner");
    await createBusiness(owner.headers, { businessName: "Perf Shop", template: "clothing" });
    const r = await getRequestContext(owner.headers);
    if (r.kind !== "member") throw new Error("member");
    const ctx = r.ctx;
    const lists = await getCatalogLists(ctx);
    const product = await createProduct(ctx, {
      name: "Perf Shirt",
      unitId: lists.units.find((u) => u.code === "pcs")?.id ?? "",
      taxCategory: "test_5",
      variants: [{ sku: `PERF-${randomUUID().slice(0, 6)}`, sellingPricePaise: 79_900, costPricePaise: 40_000 }],
    });
    const variantId = product.variants[0]?.id ?? "";
    const branchId = (await listBranches(ctx))[0]?.id ?? "";

    // The bills, written straight in (as the app's own role, through
    // row-level security): one statement each for bills, lines, payments.
    const load = await timed("load 50,000 bills", () =>
      withTenant(ctx, async (tx) => {
        await tx.update(settings).set({ gstRegistration: "registered", gstin: "33ABCDE1234F1Z7", stateCode: "33" });
        await tx.execute(sql`
          CREATE TEMP TABLE perf_bills ON COMMIT DROP AS
          SELECT gen_random_uuid() AS id, g AS n, (current_date - (g % 365))::date AS day FROM generate_series(1, ${BILLS}) g`);
        await tx.execute(sql`
          INSERT INTO invoices (id, tenant_id, branch_id, number, prefix, financial_year, sequence_number, invoice_date,
                                seller_name, seller_state_code, gst_registration, prices_include_tax, charges_gst,
                                place_of_supply, inter_state, gross_paise, discount_paise, taxable_paise, cgst_paise, sgst_paise,
                                igst_paise, tax_paise, total_paise, round_off_paise, payable_paise, paid_paise, credit_paise, created_by)
          SELECT id, ${ctx.tenantId}, ${branchId}, 'PF/26-27/' || lpad(n::text, 5, '0'), 'PF', '26-27', n, day,
                 'Perf Shop', '33', 'registered', true, true, '33', false, 239700, 0, 228288, 5706, 5706, 0, 11412, 239700, 0, 239700, 239700, 0, ${ctx.userId}
            FROM perf_bills`);
        await tx.execute(sql`
          INSERT INTO invoice_items (tenant_id, invoice_id, line_number, variant_id, product_name, variant_label, sku, unit_code,
                                     quantity, unit_price_paise, tax_category, tax_label, tax_rate, gross_paise, line_discount_paise,
                                     bill_discount_paise, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, unit_cost_paise)
          -- ₹799 incl. 5%: taxable 760.96 + CGST 19.02 + SGST 19.02 (src/lib/bill-maths).
          SELECT ${ctx.tenantId}, b.id, l, ${variantId}, 'Perf Shirt', '', 'PERF', 'pcs', 1, 79900, 'test_5', 'TEST 5%', 5,
                 79900, 0, 0, 76096, 1902, 1902, 0, 79900, 40000
            FROM perf_bills b CROSS JOIN generate_series(1, 3) l`);
        await tx.execute(sql`
          INSERT INTO invoice_payments (tenant_id, invoice_id, method, amount_paise, kind, created_by)
          SELECT ${ctx.tenantId}, id, CASE WHEN n % 3 = 0 THEN 'upi' ELSE 'cash' END, 239700, 'sale', ${ctx.userId} FROM perf_bills`);
      }),
    );
    // Fresh statistics, as the database does by itself shortly after a big
    // load (app_user may not; the table owner can).
    const tableOwner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL_TEST });
    await tableOwner.connect();
    await tableOwner.query("ANALYZE invoices, invoice_items, invoice_payments");
    await tableOwner.end();

    const today = new Date().toISOString().slice(0, 10);
    const yearAgo = new Date(Date.now() - 364 * 86_400_000).toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const runs = [
      await timed("dashboard (today), first", () => getDashboard(ctx)),
      await timed("dashboard (today), again", () => getDashboard(ctx)),
      await timed("sales by day, 1 month", () => getSalesReport(ctx, { from: monthAgo, to: today })),
      await timed("sales by day, 1 year", () => getSalesReport(ctx, { from: yearAgo, to: today })),
      await timed("by item, 1 year", () => getSalesBreakdown(ctx, { from: yearAgo, to: today, by: "item" })),
      await timed("by staff, 1 year", () => getSalesBreakdown(ctx, { from: yearAgo, to: today, by: "user" })),
      await timed("money in and out, 1 year", () => getPaymentsReport(ctx, { from: yearAgo, to: today })),
      await timed("profit, 1 year", () => getProfitReport(ctx, { from: yearAgo, to: today })),
      await timed("GST summary, 1 year", () => getTaxSummary(ctx, { from: yearAgo, to: today })),
    ];
    process.stdout.write(`\n${load.label}: ${String(load.ms)} ms\n`);
    for (const run of runs) process.stdout.write(`${run.label}: ${String(run.ms)} ms\n`);

    // The year's totals are exactly 50,000 bills of ₹2,397.
    const year = runs[3]?.result as Awaited<ReturnType<typeof getSalesReport>>;
    expect(year.bills).toBe(BILLS);
    expect(year.salesPaise).toBe(BILLS * 239_700);
    for (const run of runs) expect(run.ms).toBeLessThan(5000);
  });
});
