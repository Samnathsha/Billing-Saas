import "server-only";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { quantityToMilli } from "@/lib/bill-maths";
import { hasPermission, requirePermission, type Permission } from "@/modules/auth";
import { claimIdempotencyKey } from "@/modules/sync";
import * as repo from "./repo";
import { daysBetween, milliText, planReturn, writeReturn } from "./return-core";
import { todayIn } from "./sale-core";
import { SalesError } from "./errors";

// Returns against a bill (blueprint 7.6; business rules 16) as ONE
// transaction: the bill is locked (returns against one bill happen one at a
// time), each quantity is checked against what was sold minus earlier
// returns, amounts reverse the bill's own lines at their own rates
// (src/lib/return-maths), the credit note number is taken, resellable items go
// back into stock at the bill's cost, IMEIs come back (or are scrapped),
// store credit goes on the customer's account, audited.

const VIEW: readonly Permission[] = ["sales.create", "reports.view", "invoices.void"];

export const createReturnInput = z.strictObject({
  idempotencyKey: z.uuid(),
  // The credit note's id, made on the device.
  creditNoteId: z.uuid(),
  invoiceId: z.uuid(),
  branchId: z.uuid(),
  refundMethod: z.enum(["cash", "card", "upi", "store_credit"], { error: "Choose how the money goes back." }),
  reason: z.string().trim().min(3, { error: "Say why the items came back." }).max(500),
  lines: z
    .array(
      z.strictObject({
        invoiceItemId: z.uuid(),
        quantity: z.string().trim().regex(/^\d{1,11}(\.\d{1,3})?$/, { error: "Enter a quantity (at most 3 decimals)." }),
        resellable: z.boolean(),
      }),
    )
    .min(1, { error: "Choose at least one item to return." })
    .max(200),
});

export interface ReturnableLineDto {
  invoiceItemId: string;
  lineNumber: number;
  name: string;
  sku: string;
  serial: string | null;
  unitCode: string;
  sold: string;
  returned: string;
  remaining: string;
  totalPaise: number;
  // The line's own amounts, so a screen can preview a refund exactly.
  taxablePaise: number;
  cgstPaise: number;
  igstPaise: number;
}

export interface ReturnableDto {
  invoiceId: string;
  number: string;
  invoiceDate: string;
  status: "posted" | "voided";
  customerId: string | null;
  buyerName: string | null;
  // A new bill for the same customer is in the same place of supply.
  interState: boolean;
  // Days since the bill and the business's window (business rules 16).
  daysSince: number;
  windowDays: number;
  lines: ReturnableLineDto[];
  // exchangePaise: the part that paid a new bill (an exchange).
  creditNotes: { id: string; number: string; creditNoteDate: string; refundPaise: number; refundMethod: string; exchangePaise: number }[];
}

export interface CreditNoteDto {
  id: string;
  number: string;
  creditNoteDate: string;
  invoice: { id: string; number: string; invoiceDate: string };
  seller: { name: string; address: string | null; gstin: string | null; stateCode: string };
  buyer: { customerId: string | null; name: string | null; phone: string | null; address: string | null; gstin: string | null };
  placeOfSupply: string;
  interState: boolean;
  chargesGst: boolean;
  refundMethod: "cash" | "card" | "upi" | "store_credit" | "exchange";
  exchange: { invoiceId: string; paise: number } | null;
  reason: string;
  outsideWindow: boolean;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
  roundOffPaise: number;
  refundPaise: number;
  items: {
    lineNumber: number;
    name: string;
    sku: string;
    hsnCode: string | null;
    serial: string | null;
    unitCode: string;
    quantity: string;
    resellable: boolean;
    taxLabel: string;
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    totalPaise: number;
  }[];
}


export async function createReturn(ctx: TenantContext, rawInput: unknown): Promise<{ creditNoteId: string }> {
  await requirePermission(ctx, "sales.create");
  const input = createReturnInput.parse(rawInput);
  const mayPassWindow = await hasPermission(ctx, "invoices.void");
  return withTenant(ctx, async (tx) => {
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "sales.return", { creditNoteId: input.creditNoteId });
    if (!claim.claimed) return claim.result;

    // Store credit needs a customer on the bill (checked before any work).
    const plan = await planReturn(tx, ctx, input, { mayPassWindow });
    await writeReturn(tx, ctx, plan, { creditNoteId: input.creditNoteId, branchId: input.branchId, reason: input.reason, refundMethod: input.refundMethod });
    return { creditNoteId: input.creditNoteId };
  });
}

export async function getReturnable(ctx: TenantContext, rawInput: unknown): Promise<ReturnableDto> {
  await requirePermission(ctx, VIEW);
  const { invoiceId } = z.strictObject({ invoiceId: z.uuid() }).parse(rawInput);
  return withTenant(ctx, async (tx) => {
    const invoice = await repo.findInvoice(tx, invoiceId);
    if (invoice === undefined) throw new SalesError("NOT_FOUND");
    const settings = await repo.saleSettings(tx);
    const items = await repo.itemsOf(tx, invoiceId);
    const returned = await repo.returnedQuantities(tx, invoiceId);
    const serials = await repo.serialTexts(tx, items.map((i) => i.serialNumberId).filter((s): s is string => s !== null));
    return {
      invoiceId,
      number: invoice.number,
      invoiceDate: invoice.invoiceDate,
      status: invoice.status === "voided" ? "voided" : "posted",
      customerId: invoice.customerId,
      buyerName: invoice.buyerName,
      interState: invoice.interState,
      daysSince: daysBetween(invoice.invoiceDate, todayIn(settings?.timeZone ?? "Asia/Kolkata")),
      windowDays: settings?.returnWindowDays ?? 7,
      lines: items.map((i) => {
        const sold = quantityToMilli(i.quantity);
        const back = quantityToMilli(returned.get(i.id) ?? "0");
        return {
          invoiceItemId: i.id,
          lineNumber: i.lineNumber,
          name: i.variantLabel === "" ? i.productName : `${i.productName} · ${i.variantLabel}`,
          sku: i.sku,
          serial: i.serialNumberId === null ? null : (serials.get(i.serialNumberId) ?? null),
          unitCode: i.unitCode,
          sold: milliText(sold),
          returned: milliText(back),
          remaining: milliText(sold - back),
          totalPaise: i.totalPaise,
          taxablePaise: i.taxablePaise,
          cgstPaise: i.cgstPaise,
          igstPaise: i.igstPaise,
        };
      }),
      creditNotes: await repo.creditNotesOfInvoice(tx, invoiceId),
    };
  });
}

export async function getCreditNote(ctx: TenantContext, rawInput: unknown): Promise<CreditNoteDto> {
  await requirePermission(ctx, VIEW);
  const { creditNoteId } = z.strictObject({ creditNoteId: z.uuid() }).parse(rawInput);
  return withTenant(ctx, async (tx) => {
    const note = await repo.findCreditNote(tx, creditNoteId);
    if (note === undefined) throw new SalesError("CREDIT_NOTE_NOT_FOUND");
    const invoice = await repo.findInvoice(tx, note.invoiceId);
    if (invoice === undefined) throw new Error("credit note without its bill");
    const items = await repo.creditNoteItemsOf(tx, creditNoteId);
    const serials = await repo.serialTexts(tx, items.map((i) => i.serialNumberId).filter((s): s is string => s !== null));
    const method = note.refundMethod;
    return {
      id: note.id,
      number: note.number,
      creditNoteDate: note.creditNoteDate,
      invoice: { id: invoice.id, number: invoice.number, invoiceDate: invoice.invoiceDate },
      seller: { name: invoice.sellerName, address: invoice.sellerAddress, gstin: invoice.sellerGstin, stateCode: invoice.sellerStateCode },
      buyer: { customerId: invoice.customerId, name: invoice.buyerName, phone: invoice.buyerPhone, address: invoice.buyerAddress, gstin: invoice.buyerGstin },
      placeOfSupply: invoice.placeOfSupply,
      interState: invoice.interState,
      chargesGst: invoice.chargesGst,
      refundMethod: method === "card" || method === "upi" || method === "store_credit" || method === "exchange" ? method : "cash",
      exchange: note.exchangeInvoiceId === null ? null : { invoiceId: note.exchangeInvoiceId, paise: note.exchangePaise },
      reason: note.reason,
      outsideWindow: note.outsideWindow,
      taxablePaise: note.taxablePaise,
      cgstPaise: note.cgstPaise,
      sgstPaise: note.sgstPaise,
      igstPaise: note.igstPaise,
      taxPaise: note.taxPaise,
      totalPaise: note.totalPaise,
      roundOffPaise: note.roundOffPaise,
      refundPaise: note.refundPaise,
      items: items.map((i) => ({
        lineNumber: i.lineNumber,
        name: i.variantLabel === "" ? i.productName : `${i.productName} · ${i.variantLabel}`,
        sku: i.sku,
        hsnCode: i.hsnCode,
        serial: i.serialNumberId === null ? null : (serials.get(i.serialNumberId) ?? null),
        unitCode: i.unitCode,
        quantity: i.quantity,
        resellable: i.resellable,
        taxLabel: i.taxLabel,
        taxablePaise: i.taxablePaise,
        cgstPaise: i.cgstPaise,
        sgstPaise: i.sgstPaise,
        igstPaise: i.igstPaise,
        totalPaise: i.totalPaise,
      })),
    };
  });
}
