import { headers } from "next/headers";
import { ZodError } from "zod";
import { toCsv } from "@/lib/csv-write";
import { paiseToRupeesText } from "@/lib/money";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import {
  ExportLimitError,
  getAgeing,
  getLowStock,
  getPaymentsReport,
  getProfitReport,
  getSalesBreakdown,
  getSalesReport,
  getStockValue,
  getTaxSummary,
  recordExport,
} from "@/modules/reports";

// CSV download of a report (blueprint Phase 9): the business and user come
// from the session; each report checks its own permission; downloads are
// rate limited and audited (recordExport); cells are safe to open in a
// spreadsheet (csv-write). Amounts in rupees with 2 decimals.

const rupees = (paise: number): string => paiseToRupeesText(paise);
type Ctx = Extract<Awaited<ReturnType<typeof getRequestContext>>, { kind: "member" }>["ctx"];

const REPORTS: Record<string, { dated: boolean; build: (ctx: Ctx, range: { from: string; to: string }) => Promise<(string | number)[][]> }> = {
  sales: {
    dated: true,
    build: async (ctx, range) => {
      const r = await getSalesReport(ctx, range);
      return [["Day", "Bills", "Sales (₹)", "Returns (₹)", "Net (₹)"], ...r.days.map((d) => [d.day, d.bills, rupees(d.salesPaise), rupees(d.returnsPaise), rupees(d.netPaise)])];
    },
  },
  ...Object.fromEntries(
    (["item", "category", "user"] as const).map((by) => [
      `by_${by}`,
      {
        dated: true,
        build: async (ctx: Ctx, range: { from: string; to: string }) => {
          const rows = await getSalesBreakdown(ctx, { ...range, by });
          return [
            [by === "item" ? "Item" : by === "category" ? "Category" : "Staff member", "SKU", "Bills", "Sold", "Returned", "Sales (₹)", "Returns (₹)", "Net (₹)"],
            ...rows.map((r) => [r.name, r.sku, r.bills, r.quantitySold, r.quantityReturned, rupees(r.salesPaise), rupees(r.returnsPaise), rupees(r.netPaise)]),
          ];
        },
      },
    ]),
  ),
  payments: {
    dated: true,
    build: async (ctx, range) => {
      const r = await getPaymentsReport(ctx, range);
      return [["Method", "Received (₹)", "Refunded (₹)", "Expenses (₹)", "Net (₹)"], ...r.methods.map((m) => [m.method, rupees(m.receivedPaise), rupees(m.refundedPaise), rupees(m.expensesPaise), rupees(m.netPaise)])];
    },
  },
  profit: {
    dated: true,
    build: async (ctx, range) => {
      const p = await getProfitReport(ctx, range);
      return [
        ["Line", "Amount (₹)"],
        ["Sales without GST", rupees(p.salesTaxablePaise)],
        ["Returns without GST", rupees(p.returnsTaxablePaise)],
        ["Net sales", rupees(p.netSalesPaise)],
        ["Cost of goods sold", rupees(p.costOfGoodsPaise)],
        ["Gross profit", rupees(p.grossProfitPaise)],
        ["Expenses", rupees(p.expensesPaise)],
        ["Net profit", rupees(p.netProfitPaise)],
      ];
    },
  },
  stock: {
    dated: false,
    build: async (ctx) => {
      const s = await getStockValue(ctx);
      return [["Branch", "Quantity", "Value at average cost (₹)"], ...s.branches.map((b) => [b.branch, b.quantity, rupees(b.valuePaise)]), ["Total", "", rupees(s.totalPaise)]];
    },
  },
  low_stock: {
    dated: false,
    build: async (ctx) => [["Item", "SKU", "Branch", "In stock", "Reorder level"], ...(await getLowStock(ctx)).map((r) => [r.name, r.sku, r.branch, r.quantity, r.reorderLevel])],
  },
  ...Object.fromEntries(
    (["customer", "supplier"] as const).map((party) => [
      `${party}_ageing`,
      {
        dated: false,
        build: async (ctx: Ctx) => [
          [party === "customer" ? "Customer" : "Supplier", "Balance (₹)", "0-30 days", "31-60 days", "61-90 days", "Over 90 days"],
          ...(await getAgeing(ctx, { party })).map((r) => [r.name, rupees(r.balancePaise), rupees(r.days0to30Paise), rupees(r.days31to60Paise), rupees(r.days61to90Paise), rupees(r.over90Paise)]),
        ],
      },
    ]),
  ),
  tax: {
    dated: true,
    build: async (ctx, range) => {
      const t = await getTaxSummary(ctx, range);
      return [
        ["GST summary: validate with your accountant"],
        ["Output (sales)", "Rate %", "Taxable (₹)", "CGST (₹)", "SGST (₹)", "IGST (₹)"],
        ...t.output.map((r) => ["", r.rate, rupees(r.taxablePaise), rupees(r.cgstPaise), rupees(r.sgstPaise), rupees(r.igstPaise)]),
        ["Input (purchases)", "Rate %", "Taxable (₹)", "GST (₹)"],
        ...t.input.map((r) => ["", r.rate, rupees(r.taxablePaise), rupees(r.taxPaise)]),
        ["Output GST", rupees(t.outputTaxPaise)],
        ["Input GST", rupees(t.inputTaxPaise)],
      ];
    },
  },
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request): Promise<Response> {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") return Response.json({ message: "Please log in." }, { status: 401 });
  const url = new URL(request.url);
  const name = url.searchParams.get("report") ?? "";
  const report = Object.hasOwn(REPORTS, name) ? REPORTS[name] : undefined;
  if (report === undefined) return Response.json({ message: "Unknown report." }, { status: 404 });
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (report.dated && (!DATE.test(from) || !DATE.test(to))) return Response.json({ message: "Choose the dates." }, { status: 400 });
  try {
    await recordExport(who.ctx, { report: name, from: report.dated ? from : null, to: report.dated ? to : null });
    const rows = await report.build(who.ctx, { from, to });
    const file = `${name}${report.dated ? `_${from}_${to}` : ""}.csv`;
    return new Response(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return Response.json({ message: "Your role does not allow this report." }, { status: 403 });
    if (error instanceof ExportLimitError) return Response.json({ message: error.message }, { status: 429 });
    if (error instanceof ZodError) return Response.json({ message: "Please check the dates (at most one year)." }, { status: 400 });
    console.error("report export failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ message: "Something went wrong." }, { status: 500 });
  }
}
