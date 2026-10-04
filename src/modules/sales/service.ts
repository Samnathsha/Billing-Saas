import "server-only";
import { z } from "zod";
import { withTenant, type TenantContext, type TenantTx } from "@/db/with-tenant";
import { hasPermission, requirePermission, type Permission } from "@/modules/auth";
import { reverseStockOf } from "@/modules/inventory";
import { bookCustomerEntry } from "@/modules/parties";
import { claimIdempotencyKey } from "@/modules/sync";
import { SalesError } from "./errors";
import * as repo from "./repo";
import { postSale, todayIn } from "./sale-core";

// The sale (blueprint 7.5; business rules 3-8 and 15) as ONE transaction:
// idempotency key, settings, items, prices and tax rates from the database
// (never from the browser), discount limit, customer and credit, the bill
// number, the bill with its lines and payments, stock out, IMEI numbers
// sold, the customer's account, and the audit entry. Any failure undoes
// everything, including the bill number.

const VIEW: readonly Permission[] = ["sales.create", "reports.view", "invoices.void"];
const QTY_POSITIVE = /^\d{1,11}(\.\d{1,3})?$/;
const SERIAL = /^[A-Za-z0-9-]{4,40}$/;
const MAX_PAISE = 100_000_000_000;

export const createSaleInput = z.strictObject({
  // Retries and double clicks send the same key (blueprint 8.1).
  idempotencyKey: z.uuid(),
  // The bill's id, made on the device.
  invoiceId: z.uuid(),
  branchId: z.uuid(),
  customerId: z.uuid().nullable().default(null),
  lines: z
    .array(
      z.strictObject({
        variantId: z.uuid(),
        quantity: z.string().trim().regex(QTY_POSITIVE, { error: "Enter a quantity (at most 3 decimals)." }),
        discountPaise: z.int().min(0).max(MAX_PAISE).default(0),
        serial: z.string().trim().regex(SERIAL, { error: "IMEI/serial: 4 to 40 letters, digits or -" }).nullable().default(null),
      }),
    )
    .min(1, { error: "Add at least one item." })
    .max(200),
  billDiscountPaise: z.int().min(0).max(MAX_PAISE).default(0),
  payments: z
    .array(
      z.strictObject({
        method: z.enum(["cash", "card", "upi"]),
        amountPaise: z.int().min(1).max(MAX_PAISE),
        reference: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(100).nullable()).default(null),
      }),
    )
    .max(5)
    .default([]),
  // What the till showed. If the server's total differs (a price or rate
  // changed meanwhile), the sale is refused rather than charging a surprise.
  expectedPayablePaise: z.int().min(0).max(MAX_PAISE).nullable().default(null),
});

export const voidInvoiceInput = z.strictObject({
  idempotencyKey: z.uuid(),
  invoiceId: z.uuid(),
  reason: z.string().trim().min(3, { error: "Say why this bill is voided." }).max(500),
});

export interface InvoiceDto {
  id: string;
  number: string;
  invoiceDate: string;
  status: "posted" | "voided";
  branchId: string;
  seller: { name: string; address: string | null; gstin: string | null; stateCode: string; gstRegistration: string };
  buyer: { customerId: string | null; name: string | null; phone: string | null; address: string | null; gstin: string | null };
  placeOfSupply: string;
  interState: boolean;
  pricesIncludeTax: boolean;
  chargesGst: boolean;
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
  roundOffPaise: number;
  payablePaise: number;
  paidPaise: number;
  creditPaise: number;
  voidReason: string | null;
  createdAt: string;
  items: {
    lineNumber: number;
    variantId: string;
    productName: string;
    variantLabel: string;
    sku: string;
    hsnCode: string | null;
    unitCode: string;
    serial: string | null;
    quantity: string;
    unitPricePaise: number;
    taxLabel: string;
    taxRate: string;
    grossPaise: number;
    discountPaise: number;
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    totalPaise: number;
    // Only for "View cost price and profit".
    unitCostPaise?: string;
  }[];
  // method: cash | card | upi | exchange (paid with returned items).
  payments: { method: string; amountPaise: number; reference: string | null; kind: "sale" | "void" }[];
}

export async function createSale(ctx: TenantContext, rawInput: unknown): Promise<{ invoiceId: string }> {
  await requirePermission(ctx, "sales.create");
  const input = createSaleInput.parse(rawInput);
  const unlimitedDiscount = await hasPermission(ctx, "discounts.above_limit");
  return withTenant(ctx, async (tx) => {
    // 1. A retry or double click returns the bill already saved.
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "sales.create", { invoiceId: input.invoiceId });
    if (!claim.claimed) return claim.result;
    await postSale(tx, ctx, input, { unlimitedDiscount });
    return { invoiceId: input.invoiceId };
  });
}


// Void (business rules 6 and 15): Manager or above, with a reason, only on
// the day of the bill. New rows reverse the stock, the money received and
// the customer's account; the bill's own rows never change.
export async function voidInvoice(ctx: TenantContext, rawInput: unknown): Promise<{ invoiceId: string }> {
  await requirePermission(ctx, "invoices.void");
  const input = voidInvoiceInput.parse(rawInput);
  return withTenant(ctx, async (tx) => {
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "sales.void", { invoiceId: input.invoiceId });
    if (!claim.claimed) return claim.result;
    const invoice = await repo.lockInvoice(tx, input.invoiceId);
    if (invoice === undefined) throw new SalesError("NOT_FOUND");
    if (invoice.status !== "posted") throw new SalesError("ALREADY_VOIDED");
    const business = await repo.saleSettings(tx);
    if (business === undefined || invoice.invoiceDate !== todayIn(business.timeZone)) throw new SalesError("VOID_ONLY_SAME_DAY");
    // Blueprint 7.6: no void once a return depends on the bill.
    if (await repo.hasCreditNotes(tx, invoice.id)) throw new SalesError("RETURNS_EXIST");
    const received = (await repo.paymentsOf(tx, invoice.id)).filter((p) => p.kind === "sale");
    // Paid with returned items (an exchange): voiding would make that value
    // vanish. A return is used instead.
    if (received.some((p) => p.method === "exchange")) throw new SalesError("EXCHANGE_BILL");

    await reverseStockOf(tx, ctx, { sourceType: "invoice", sourceId: invoice.id, reversalSourceType: "invoice_void", note: input.reason });
    await repo.insertPayments(
      tx,
      ctx,
      received.map((p) => ({ invoiceId: invoice.id, method: p.method, amountPaise: -p.amountPaise, reference: p.reference, kind: "void" })),
    );
    if (invoice.customerId !== null && invoice.creditPaise > 0) {
      await bookCustomerEntry(tx, ctx, { customerId: invoice.customerId, entryType: "void_reversal", amountPaise: -invoice.creditPaise, sourceType: "invoice", sourceId: invoice.id, note: input.reason });
    }
    await repo.markVoided(tx, ctx, invoice.id, input.reason);
    await repo.addAuditEntry(tx, ctx, {
      action: "sales.invoice_voided",
      entityType: "invoice",
      entityId: invoice.id,
      before: { status: "posted", number: invoice.number },
      after: { status: "voided", reason: input.reason, refundedPaise: received.reduce((s, p) => s + p.amountPaise, 0) },
    });
    return { invoiceId: invoice.id };
  });
}

async function readInvoice(tx: TenantTx, invoiceId: string, showCost: boolean): Promise<InvoiceDto> {
  const row = await repo.findInvoice(tx, invoiceId);
  if (row === undefined) throw new SalesError("NOT_FOUND");
  const items = await repo.itemsOf(tx, invoiceId);
  const serialIds = items.map((i) => i.serialNumberId).filter((s): s is string => s !== null);
  const serialNames = await repo.serialTexts(tx, serialIds);
  const payments = await repo.paymentsOf(tx, invoiceId);
  return {
    id: row.id,
    number: row.number,
    invoiceDate: row.invoiceDate,
    status: row.status === "voided" ? "voided" : "posted",
    branchId: row.branchId,
    seller: { name: row.sellerName, address: row.sellerAddress, gstin: row.sellerGstin, stateCode: row.sellerStateCode, gstRegistration: row.gstRegistration },
    buyer: { customerId: row.customerId, name: row.buyerName, phone: row.buyerPhone, address: row.buyerAddress, gstin: row.buyerGstin },
    placeOfSupply: row.placeOfSupply,
    interState: row.interState,
    pricesIncludeTax: row.pricesIncludeTax,
    chargesGst: row.chargesGst,
    grossPaise: row.grossPaise,
    discountPaise: row.discountPaise,
    taxablePaise: row.taxablePaise,
    cgstPaise: row.cgstPaise,
    sgstPaise: row.sgstPaise,
    igstPaise: row.igstPaise,
    taxPaise: row.taxPaise,
    totalPaise: row.totalPaise,
    roundOffPaise: row.roundOffPaise,
    payablePaise: row.payablePaise,
    paidPaise: row.paidPaise,
    creditPaise: row.creditPaise,
    voidReason: row.voidReason,
    createdAt: row.createdAt.toISOString(),
    items: items.map((i) => ({
      lineNumber: i.lineNumber,
      variantId: i.variantId,
      productName: i.productName,
      variantLabel: i.variantLabel,
      sku: i.sku,
      hsnCode: i.hsnCode,
      unitCode: i.unitCode,
      serial: i.serialNumberId === null ? null : (serialNames.get(i.serialNumberId) ?? null),
      quantity: i.quantity,
      unitPricePaise: i.unitPricePaise,
      taxLabel: i.taxLabel,
      taxRate: i.taxRate,
      grossPaise: i.grossPaise,
      discountPaise: i.lineDiscountPaise + i.billDiscountPaise,
      taxablePaise: i.taxablePaise,
      cgstPaise: i.cgstPaise,
      sgstPaise: i.sgstPaise,
      igstPaise: i.igstPaise,
      totalPaise: i.totalPaise,
      ...(showCost ? { unitCostPaise: i.unitCostPaise } : {}),
    })),
    payments: payments.map((p) => ({ method: p.method, amountPaise: p.amountPaise, reference: p.reference, kind: p.kind === "void" ? "void" : "sale" })),
  };
}

export async function getInvoice(ctx: TenantContext, rawInput: unknown): Promise<InvoiceDto> {
  await requirePermission(ctx, VIEW);
  const { invoiceId } = z.strictObject({ invoiceId: z.uuid() }).parse(rawInput);
  const showCost = await hasPermission(ctx, "costs.view");
  return withTenant(ctx, (tx) => readInvoice(tx, invoiceId, showCost));
}

export interface InvoiceListItemDto {
  id: string;
  number: string;
  invoiceDate: string;
  status: "posted" | "voided";
  buyerName: string | null;
  payablePaise: number;
  paidPaise: number;
  creditPaise: number;
  createdAt: string;
}

export async function listInvoices(ctx: TenantContext, rawInput: unknown = {}): Promise<InvoiceListItemDto[]> {
  await requirePermission(ctx, VIEW);
  const input = z
    .strictObject({
      day: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .default(null),
      customerId: z.uuid().nullable().default(null),
    })
    .parse(rawInput);
  const rows = await withTenant(ctx, (tx) => repo.listInvoices(tx, input));
  return rows.map((r) => ({ ...r, status: r.status === "voided" ? "voided" : "posted", createdAt: r.createdAt.toISOString() }));
}
