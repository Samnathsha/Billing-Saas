import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { quantityToMilli } from "@/lib/bill-maths";
import { hasPermission, requirePermission, type Permission } from "@/modules/auth";
import { postMovements, returnSerial, type MovementInput } from "@/modules/inventory";
import { bookCustomerEntry } from "@/modules/parties";
import { claimIdempotencyKey } from "@/modules/sync";
import { financialYearLabel, financialYearStart } from "./numbering";
import * as repo from "./repo";
import { returnAmounts } from "./returns-maths";
import { takeNextNumber } from "./sequence";
import { SalesError } from "./service";

// Returns against a bill (blueprint 7.6; business rules 16) as ONE
// transaction: the bill is locked (returns against one bill happen one at a
// time), each quantity is checked against what was sold minus earlier
// returns, amounts reverse the bill's own lines at their own rates
// (returns-maths), the credit note number is taken, resellable items go
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
}

export interface ReturnableDto {
  invoiceId: string;
  number: string;
  invoiceDate: string;
  status: "posted" | "voided";
  customerId: string | null;
  buyerName: string | null;
  // Days since the bill and the business's window (business rules 16).
  daysSince: number;
  windowDays: number;
  lines: ReturnableLineDto[];
  creditNotes: { id: string; number: string; creditNoteDate: string; refundPaise: number; refundMethod: string }[];
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
  refundMethod: "cash" | "card" | "upi" | "store_credit";
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

const todayIn = (timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const milliText = (milli: bigint): string => `${String(milli / 1000n)}.${String(milli % 1000n).padStart(3, "0")}`;

export async function createReturn(ctx: TenantContext, rawInput: unknown): Promise<{ creditNoteId: string }> {
  await requirePermission(ctx, "sales.create");
  const input = createReturnInput.parse(rawInput);
  const mayPassWindow = await hasPermission(ctx, "invoices.void");
  return withTenant(ctx, async (tx) => {
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "sales.return", { creditNoteId: input.creditNoteId });
    if (!claim.claimed) return claim.result;

    const settings = await repo.saleSettings(tx);
    if (settings === undefined) throw new SalesError("SETTINGS_INCOMPLETE");
    const today = todayIn(settings.timeZone);
    // Locked: two returns against the same bill happen one after the other.
    const invoice = await repo.lockInvoice(tx, input.invoiceId);
    if (invoice === undefined) throw new SalesError("NOT_FOUND");
    if (invoice.status !== "posted") throw new SalesError("INVOICE_VOIDED");
    const outsideWindow = daysBetween(invoice.invoiceDate, today) > settings.returnWindowDays;
    if (outsideWindow && !mayPassWindow) throw new SalesError("RETURN_WINDOW_PASSED");
    if (input.refundMethod === "store_credit" && invoice.customerId === null) throw new SalesError("STORE_CREDIT_NEEDS_CUSTOMER");

    const items = new Map((await repo.itemsOf(tx, invoice.id)).map((i) => [i.id, i]));
    const returned = await repo.returnedQuantities(tx, invoice.id);
    if (new Set(input.lines.map((l) => l.invoiceItemId)).size !== input.lines.length) throw new SalesError("BAD_BILL", "Each bill line once.");

    const lines = input.lines.map((l, index) => {
      const item = items.get(l.invoiceItemId);
      if (item === undefined) throw new SalesError("ITEM_NOT_ON_BILL");
      const sold = quantityToMilli(item.quantity);
      const already = quantityToMilli(returned.get(item.id) ?? "0");
      const now = quantityToMilli(l.quantity);
      if (now === 0n) throw new SalesError("BAD_BILL", "Enter a quantity above zero.");
      if (already + now > sold) throw new SalesError("RETURN_TOO_MANY", `(${item.productName})`);
      const amounts = returnAmounts(item, sold, already, now);
      return { ...l, id: randomUUID(), lineNumber: index + 1, item, quantity: milliText(now), amounts };
    });

    const sum = (pick: (a: (typeof lines)[number]["amounts"]) => number): number => lines.reduce((s, l) => s + pick(l.amounts), 0);
    const totalPaise = sum((a) => a.totalPaise);
    const roundOffPaise = Number(((2n * BigInt(totalPaise) + 100n) / 200n) * 100n) - totalPaise;
    const refundPaise = totalPaise + roundOffPaise;

    const fy = financialYearLabel(financialYearStart(new Date(), settings.timeZone, settings.financialYearStartMonth), settings.financialYearStartMonth);
    const number = await takeNextNumber(tx, ctx, { kind: "credit_note", prefix: settings.creditNotePrefix, financialYear: fy });

    await repo.insertCreditNote(tx, ctx, {
      id: input.creditNoteId,
      invoiceId: invoice.id,
      branchId: input.branchId,
      number: number.formatted,
      prefix: settings.creditNotePrefix,
      financialYear: fy,
      sequenceNumber: number.number,
      creditNoteDate: today,
      customerId: invoice.customerId,
      refundMethod: input.refundMethod,
      reason: input.reason,
      outsideWindow,
      taxablePaise: sum((a) => a.taxablePaise),
      cgstPaise: sum((a) => a.cgstPaise),
      sgstPaise: sum((a) => a.sgstPaise),
      igstPaise: sum((a) => a.igstPaise),
      taxPaise: sum((a) => a.cgstPaise + a.sgstPaise + a.igstPaise),
      totalPaise,
      roundOffPaise,
      refundPaise,
    });
    await repo.insertCreditNoteItems(
      tx,
      ctx,
      lines.map((l) => ({
        id: l.id,
        creditNoteId: input.creditNoteId,
        lineNumber: l.lineNumber,
        invoiceItemId: l.item.id,
        variantId: l.item.variantId,
        serialNumberId: l.item.serialNumberId,
        quantity: l.quantity,
        resellable: l.resellable,
        taxablePaise: l.amounts.taxablePaise,
        cgstPaise: l.amounts.cgstPaise,
        sgstPaise: l.amounts.sgstPaise,
        igstPaise: l.amounts.igstPaise,
        totalPaise: l.amounts.totalPaise,
      })),
    );

    // Stock: resellable items back on the shelf at the bill's cost; damaged
    // ones stay out of stock (recorded on the credit note).
    for (const l of lines) {
      if (l.item.serialNumberId !== null) await returnSerial(tx, l.item.serialNumberId, { branchId: input.branchId, resellable: l.resellable });
    }
    const movements: MovementInput[] = lines
      .filter((l) => l.resellable)
      .map((l) => ({
        branchId: input.branchId,
        variantId: l.item.variantId,
        type: "SALE_RETURN_IN",
        quantity: l.quantity,
        unitCostPaise: l.item.unitCostPaise,
        sourceType: "credit_note",
        sourceId: input.creditNoteId,
        sourceLineId: l.id,
        ...(l.item.serialNumberId === null ? {} : { serialNumberId: l.item.serialNumberId }),
      }));
    if (movements.length > 0) await postMovements(tx, ctx, movements);

    if (input.refundMethod === "store_credit" && invoice.customerId !== null && refundPaise > 0) {
      await bookCustomerEntry(tx, ctx, { customerId: invoice.customerId, entryType: "return", amountPaise: -refundPaise, sourceType: "credit_note", sourceId: input.creditNoteId, note: number.formatted });
    }
    await repo.addAuditEntry(tx, ctx, {
      action: outsideWindow ? "sales.return_after_window" : "sales.return_created",
      entityType: "credit_note",
      entityId: input.creditNoteId,
      before: null,
      after: { number: number.formatted, invoice: invoice.number, refundPaise, refundMethod: input.refundMethod, lines: lines.length, reason: input.reason },
    });
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
      refundMethod: method === "card" || method === "upi" || method === "store_credit" ? method : "cash",
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
