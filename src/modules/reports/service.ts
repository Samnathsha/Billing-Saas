import "server-only";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { requirePermission, type Permission } from "@/modules/auth";
import * as repo from "./repo";

// Reports and the dashboard (blueprint Phase 9). "View reports" for all;
// profit and stock value also need "View cost price and profit" (cashiers
// never see cost); the audit log needs "Business and tax settings" (Owner
// and Admin). Dates are days in the business's time zone (bills already
// carry their local date). Totals come from the database (repo.ts).

const LOW_STOCK_VIEW: readonly Permission[] = ["reports.view", "stock.adjust", "products.manage"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;

const day = z
  .string()
  .regex(DATE, { error: "Enter a date." })
  .refine((v) => new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), { error: "Enter a valid date." });

export const dateRangeInput = z
  .strictObject({ from: day, to: day })
  .refine((v) => v.from <= v.to, { error: "The start date is after the end date." })
  .refine((v) => (Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`)) / 86_400_000 < MAX_DAYS, { error: "Choose at most one year at a time." });

const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const text = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" ? String(value) : value instanceof Date ? value.toISOString() : "";
const todayIn = (timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export interface SalesReportDto {
  from: string;
  to: string;
  bills: number;
  voided: number;
  salesPaise: number; // posted bills, as charged (with GST, after round-off)
  returnsPaise: number; // credit notes in the dates
  netSalesPaise: number;
  taxablePaise: number;
  taxPaise: number; // GST on bills minus GST on credit notes
  discountPaise: number;
  onCreditPaise: number;
  creditNotes: number;
  days: { day: string; bills: number; salesPaise: number; returnsPaise: number; netPaise: number }[];
}

export interface BreakdownRowDto {
  key: string;
  name: string;
  sku: string;
  bills: number;
  quantitySold: string;
  quantityReturned: string;
  salesPaise: number;
  returnsPaise: number;
  netPaise: number;
}

export interface PaymentsReportDto {
  methods: { method: string; receivedPaise: number; refundedPaise: number; expensesPaise: number; netPaise: number }[];
  totalReceivedPaise: number;
  totalRefundedPaise: number;
  totalExpensesPaise: number;
  netPaise: number;
}

export interface ProfitReportDto {
  salesTaxablePaise: number;
  returnsTaxablePaise: number;
  netSalesPaise: number;
  costOfGoodsPaise: number;
  grossProfitPaise: number;
  expensesPaise: number;
  netProfitPaise: number;
}

export interface AgeingRowDto {
  partyId: string;
  name: string;
  balancePaise: number;
  days0to30Paise: number;
  days31to60Paise: number;
  days61to90Paise: number;
  over90Paise: number;
}

export interface TaxSummaryDto {
  output: { rate: string; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }[];
  input: { rate: string; taxablePaise: number; taxPaise: number }[];
  outputTaxPaise: number;
  inputTaxPaise: number;
}

export interface AuditEntryDto {
  id: string;
  occurredAt: string;
  actor: string;
  actorRole: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: string | null;
  after: string | null;
}

export interface DashboardDto {
  today: string;
  sales: SalesReportDto;
  payments: PaymentsReportDto;
  lowStock: { name: string; sku: string; branch: string; quantity: string; reorderLevel: string }[];
  receivablesPaise: number;
  payablesPaise: number;
}

function salesReport(from: string, to: string, totals: Awaited<ReturnType<typeof repo.salesTotals>>, byDay: Awaited<ReturnType<typeof repo.salesByDay>>): SalesReportDto {
  const days = new Map<string, { bills: number; salesPaise: number; returnsPaise: number }>();
  for (const r of byDay.bills) days.set(text(r.day), { bills: num(r.bills), salesPaise: num(r.payable), returnsPaise: 0 });
  for (const r of byDay.returns) {
    const d = days.get(text(r.day)) ?? { bills: 0, salesPaise: 0, returnsPaise: 0 };
    days.set(text(r.day), { ...d, returnsPaise: num(r.refund) });
  }
  return {
    from,
    to,
    bills: totals.bills,
    voided: totals.voided,
    salesPaise: totals.payablePaise,
    returnsPaise: totals.returnsPaise,
    netSalesPaise: totals.payablePaise - totals.returnsPaise,
    taxablePaise: totals.taxablePaise - totals.returnsTaxablePaise,
    taxPaise: totals.taxPaise - totals.returnsTaxPaise,
    discountPaise: totals.discountPaise,
    onCreditPaise: totals.onCreditPaise,
    creditNotes: totals.creditNotes,
    days: [...days]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([d, v]) => ({ day: d, ...v, netPaise: v.salesPaise - v.returnsPaise })),
  };
}

function paymentsReport(p: Awaited<ReturnType<typeof repo.paymentsByMethod>>): PaymentsReportDto {
  const methods = new Map<string, { receivedPaise: number; refundedPaise: number; expensesPaise: number }>();
  const add = (method: unknown, field: "receivedPaise" | "refundedPaise" | "expensesPaise", amount: unknown) => {
    const m = methods.get(text(method)) ?? { receivedPaise: 0, refundedPaise: 0, expensesPaise: 0 };
    m[field] += num(amount);
    methods.set(text(method), m);
  };
  for (const r of p.bills) add(r.method, "receivedPaise", r.amount);
  for (const r of p.customers) add(r.method, "receivedPaise", r.amount);
  for (const r of p.refunds) add(r.method, "refundedPaise", r.amount);
  for (const r of p.expenses) add(r.method, "expensesPaise", r.amount);
  const order = ["cash", "upi", "card", "bank"];
  const list = [...methods]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([method, v]) => ({ method, ...v, netPaise: v.receivedPaise - v.refundedPaise - v.expensesPaise }));
  const sum = (pick: (m: (typeof list)[number]) => number) => list.reduce((s, m) => s + pick(m), 0);
  return {
    methods: list,
    totalReceivedPaise: sum((m) => m.receivedPaise),
    totalRefundedPaise: sum((m) => m.refundedPaise),
    totalExpensesPaise: sum((m) => m.expensesPaise),
    netPaise: sum((m) => m.netPaise),
  };
}

export async function getSalesReport(ctx: TenantContext, rawInput: unknown): Promise<SalesReportDto> {
  await requirePermission(ctx, "reports.view");
  const { from, to } = dateRangeInput.parse(rawInput);
  return withTenant(ctx, async (tx) => salesReport(from, to, await repo.salesTotals(tx, from, to), await repo.salesByDay(tx, from, to)));
}

export async function getSalesBreakdown(ctx: TenantContext, rawInput: unknown): Promise<BreakdownRowDto[]> {
  await requirePermission(ctx, "reports.view");
  const input = z.strictObject({ from: day, to: day, by: z.enum(["item", "category", "user"]) }).parse(rawInput);
  const { from, to } = dateRangeInput.parse({ from: input.from, to: input.to });
  const { sold, returned } = await withTenant(ctx, (tx) => repo.salesGrouped(tx, from, to, input.by));
  const back = new Map(returned.map((r) => [text(r.key), r]));
  const keys = new Set([...sold.map((r) => text(r.key)), ...returned.map((r) => text(r.key))]);
  return [...keys].map((key) => {
    const s = sold.find((r) => text(r.key) === key);
    const r = back.get(key);
    const label = text(s?.label);
    return {
      key,
      name: s === undefined ? "(returned only)" : label === "" ? text(s.name) : `${text(s.name)} · ${label}`,
      sku: text(s?.sku ?? ""),
      bills: num(s?.bills),
      quantitySold: text(s?.quantity ?? "0"),
      quantityReturned: text(r?.quantity ?? "0"),
      salesPaise: num(s?.total),
      returnsPaise: num(r?.total),
      netPaise: num(s?.total) - num(r?.total),
    };
  });
}

export async function getPaymentsReport(ctx: TenantContext, rawInput: unknown): Promise<PaymentsReportDto> {
  await requirePermission(ctx, "reports.view");
  const { from, to } = dateRangeInput.parse(rawInput);
  return paymentsReport(await withTenant(ctx, (tx) => repo.paymentsByMethod(tx, from, to)));
}

export async function getProfitReport(ctx: TenantContext, rawInput: unknown): Promise<ProfitReportDto> {
  await requirePermission(ctx, "reports.view");
  await requirePermission(ctx, "costs.view");
  const { from, to } = dateRangeInput.parse(rawInput);
  const p = await withTenant(ctx, (tx) => repo.profit(tx, from, to));
  const netSalesPaise = p.salesTaxablePaise - p.returnsTaxablePaise;
  const costOfGoodsPaise = p.costSoldPaise - p.costReturnedPaise;
  return {
    salesTaxablePaise: p.salesTaxablePaise,
    returnsTaxablePaise: p.returnsTaxablePaise,
    netSalesPaise,
    costOfGoodsPaise,
    grossProfitPaise: netSalesPaise - costOfGoodsPaise,
    expensesPaise: p.expensesPaise,
    netProfitPaise: netSalesPaise - costOfGoodsPaise - p.expensesPaise,
  };
}

export async function getStockValue(ctx: TenantContext): Promise<{ branches: { branchId: string; branch: string; quantity: string; valuePaise: number }[]; totalPaise: number }> {
  await requirePermission(ctx, "reports.view");
  await requirePermission(ctx, "costs.view");
  const rows = await withTenant(ctx, (tx) => repo.stockValue(tx));
  const branches = rows.map((r) => ({ branchId: text(r.branch_id), branch: text(r.branch), quantity: text(r.quantity), valuePaise: num(r.value) }));
  return { branches, totalPaise: branches.reduce((s, b) => s + b.valuePaise, 0) };
}

export async function getLowStock(ctx: TenantContext): Promise<DashboardDto["lowStock"]> {
  await requirePermission(ctx, LOW_STOCK_VIEW);
  const rows = await withTenant(ctx, (tx) => repo.lowStock(tx));
  return rows.map(lowStockRow);
}

function lowStockRow(r: Record<string, unknown>): DashboardDto["lowStock"][number] {
  const attributes = r.attributes !== null && typeof r.attributes === "object" ? Object.values(r.attributes as Record<string, unknown>).map(text).join(" / ") : "";
  return {
    name: attributes === "" ? text(r.product) : `${text(r.product)} · ${attributes}`,
    sku: text(r.sku),
    branch: text(r.branch),
    quantity: text(r.quantity),
    reorderLevel: text(r.reorder_level),
  };
}

export async function getAgeing(ctx: TenantContext, rawInput: unknown): Promise<AgeingRowDto[]> {
  await requirePermission(ctx, "reports.view");
  const { party } = z.strictObject({ party: z.enum(["customer", "supplier"]) }).parse(rawInput);
  const rows = await withTenant(ctx, async (tx) => {
    const timeZone = await repo.businessTimeZone(tx);
    return repo.ageing(tx, party, todayIn(timeZone), timeZone);
  });
  return rows.map((r) => ({
    partyId: text(r.party),
    name: text(r.name),
    balancePaise: num(r.balance),
    days0to30Paise: num(r.d0_30),
    days31to60Paise: num(r.d31_60),
    days61to90Paise: num(r.d61_90),
    over90Paise: num(r.d90),
  }));
}

export async function getTaxSummary(ctx: TenantContext, rawInput: unknown): Promise<TaxSummaryDto> {
  await requirePermission(ctx, "reports.view");
  const { from, to } = dateRangeInput.parse(rawInput);
  const t = await withTenant(ctx, (tx) => repo.taxSummary(tx, from, to));
  const rates = (list: Record<string, unknown>[]) => list.map((r) => text(r.rate));
  const outputRates = [...new Set([...rates(t.output), ...rates(t.outputReturns)])].sort((a, b) => Number(a) - Number(b));
  const inputRates = [...new Set([...rates(t.input), ...rates(t.inputReturns)])].sort((a, b) => Number(a) - Number(b));
  const pick = (list: Record<string, unknown>[], rate: string, field: string) => num(list.find((r) => text(r.rate) === rate)?.[field]);
  const output = outputRates.map((rate) => ({
    rate,
    taxablePaise: pick(t.output, rate, "taxable") - pick(t.outputReturns, rate, "taxable"),
    cgstPaise: pick(t.output, rate, "cgst") - pick(t.outputReturns, rate, "cgst"),
    sgstPaise: pick(t.output, rate, "sgst") - pick(t.outputReturns, rate, "sgst"),
    igstPaise: pick(t.output, rate, "igst") - pick(t.outputReturns, rate, "igst"),
  }));
  const input = inputRates.map((rate) => ({
    rate,
    taxablePaise: pick(t.input, rate, "taxable") - pick(t.inputReturns, rate, "taxable"),
    taxPaise: pick(t.input, rate, "tax") - pick(t.inputReturns, rate, "tax"),
  }));
  return {
    output,
    input,
    outputTaxPaise: output.reduce((s, r) => s + r.cgstPaise + r.sgstPaise + r.igstPaise, 0),
    inputTaxPaise: input.reduce((s, r) => s + r.taxPaise, 0),
  };
}

export async function listAuditLog(ctx: TenantContext, rawInput: unknown): Promise<{ entries: AuditEntryDto[]; more: boolean }> {
  await requirePermission(ctx, "settings.manage");
  const input = z
    .strictObject({
      from: day,
      to: day,
      action: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().regex(/^[a-z_.]{1,60}$/).nullable()).default(null),
      page: z.int().min(1).max(1000).default(1),
    })
    .parse(rawInput);
  dateRangeInput.parse({ from: input.from, to: input.to });
  const rows = await withTenant(ctx, async (tx) =>
    repo.auditEntries(tx, { from: input.from, to: input.to, timeZone: await repo.businessTimeZone(tx), action: input.action, offset: (input.page - 1) * 100 }),
  );
  return {
    more: rows.length > 100,
    entries: rows.slice(0, 100).map((r) => ({
      id: text(r.id),
      occurredAt: new Date(text(r.created_at)).toISOString(),
      actor: text(r.actor),
      actorRole: r.actor_role === null ? null : text(r.actor_role),
      action: text(r.action),
      entityType: r.entity_type === null ? null : text(r.entity_type),
      entityId: r.entity_id === null ? null : text(r.entity_id),
      before: r.before === null ? null : text(r.before),
      after: r.after === null ? null : text(r.after),
    })),
  };
}

export async function getDashboard(ctx: TenantContext): Promise<DashboardDto> {
  await requirePermission(ctx, "reports.view");
  return withTenant(ctx, async (tx) => {
    const timeZone = await repo.businessTimeZone(tx);
    const today = todayIn(timeZone);
    const customers = await repo.ageing(tx, "customer", today, timeZone);
    const suppliers = await repo.ageing(tx, "supplier", today, timeZone);
    const owed = (list: Record<string, unknown>[]) => list.reduce((s, r) => s + Math.max(0, num(r.balance)), 0);
    return {
      today,
      sales: salesReport(today, today, await repo.salesTotals(tx, today, today), await repo.salesByDay(tx, today, today)),
      payments: paymentsReport(await repo.paymentsByMethod(tx, today, today)),
      lowStock: (await repo.lowStock(tx)).slice(0, 10).map(lowStockRow),
      receivablesPaise: owed(customers),
      payablesPaise: owed(suppliers),
    };
  });
}
