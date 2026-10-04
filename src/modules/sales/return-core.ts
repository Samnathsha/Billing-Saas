import "server-only";
import { randomUUID } from "node:crypto";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { quantityToMilli } from "@/lib/bill-maths";
import { postMovements, returnSerial, type MovementInput } from "@/modules/inventory";
import { bookCustomerEntry } from "@/modules/parties";
import { SalesError } from "./errors";
import { financialYearLabel, financialYearStart } from "./numbering";
import * as repo from "./repo";
import { returnAmounts, type ReturnAmounts } from "@/lib/return-maths";
import { todayIn } from "./sale-core";
import { takeNextNumber } from "./sequence";

// The body of a return (blueprint 7.6), inside the caller's transaction
// after the permission check and the idempotency key, in two halves so an
// exchange can put a sale between them: planReturn checks everything and
// works out the amounts; writeReturn saves the credit note, stock, IMEIs,
// store credit and the audit entry.

export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export const milliText = (milli: bigint): string => `${String(milli / 1000n)}.${String(milli % 1000n).padStart(3, "0")}`;

type Invoice = NonNullable<Awaited<ReturnType<typeof repo.lockInvoice>>>;
type InvoiceItem = Awaited<ReturnType<typeof repo.itemsOf>>[number];

export interface ReturnPlan {
  invoice: Invoice;
  today: string;
  outsideWindow: boolean;
  lines: { id: string; lineNumber: number; item: InvoiceItem; quantity: string; resellable: boolean; amounts: ReturnAmounts }[];
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
  roundOffPaise: number;
  refundPaise: number;
  creditNote: { prefix: string; financialYear: string; number: number; formatted: string };
}

export async function planReturn(
  tx: TenantTx,
  ctx: TenantContext,
  input: { invoiceId: string; lines: { invoiceItemId: string; quantity: string; resellable: boolean }[] },
  opts: { mayPassWindow: boolean },
): Promise<ReturnPlan> {
  const settings = await repo.saleSettings(tx);
  if (settings === undefined) throw new SalesError("SETTINGS_INCOMPLETE");
  const today = todayIn(settings.timeZone);
  // Locked: two returns against the same bill happen one after the other.
  const invoice = await repo.lockInvoice(tx, input.invoiceId);
  if (invoice === undefined) throw new SalesError("NOT_FOUND");
  if (invoice.status !== "posted") throw new SalesError("INVOICE_VOIDED");
  const outsideWindow = daysBetween(invoice.invoiceDate, today) > settings.returnWindowDays;
  if (outsideWindow && !opts.mayPassWindow) throw new SalesError("RETURN_WINDOW_PASSED");

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
    return { id: randomUUID(), lineNumber: index + 1, item, quantity: milliText(now), resellable: l.resellable, amounts: returnAmounts(item, sold, already, now) };
  });

  const sum = (pick: (a: ReturnAmounts) => number): number => lines.reduce((s, l) => s + pick(l.amounts), 0);
  const totalPaise = sum((a) => a.totalPaise);
  const roundOffPaise = Number(((2n * BigInt(totalPaise) + 100n) / 200n) * 100n) - totalPaise;
  const financialYear = financialYearLabel(financialYearStart(new Date(), settings.timeZone, settings.financialYearStartMonth), settings.financialYearStartMonth);
  // Taken here (row lock; given back if anything fails) so an exchange can
  // name the credit note on the new bill's payment.
  const number = await takeNextNumber(tx, ctx, { kind: "credit_note", prefix: settings.creditNotePrefix, financialYear });
  return {
    invoice,
    today,
    outsideWindow,
    lines,
    taxablePaise: sum((a) => a.taxablePaise),
    cgstPaise: sum((a) => a.cgstPaise),
    sgstPaise: sum((a) => a.sgstPaise),
    igstPaise: sum((a) => a.igstPaise),
    taxPaise: sum((a) => a.cgstPaise + a.sgstPaise + a.igstPaise),
    totalPaise,
    roundOffPaise,
    refundPaise: totalPaise + roundOffPaise,
    creditNote: { prefix: settings.creditNotePrefix, financialYear, number: number.number, formatted: number.formatted },
  };
}

export async function writeReturn(
  tx: TenantTx,
  ctx: TenantContext,
  plan: ReturnPlan,
  options: {
    creditNoteId: string;
    branchId: string;
    reason: string;
    // How the part NOT used in an exchange goes back ('exchange' when all of
    // it paid the new bill).
    refundMethod: "cash" | "card" | "upi" | "store_credit" | "exchange";
    exchange?: { invoiceId: string; appliedPaise: number };
  },
): Promise<void> {
  const { invoice } = plan;
  const leftoverPaise = plan.refundPaise - (options.exchange?.appliedPaise ?? 0);
  if (options.refundMethod === "store_credit" && invoice.customerId === null) throw new SalesError("STORE_CREDIT_NEEDS_CUSTOMER");

  await repo.insertCreditNote(tx, ctx, {
    id: options.creditNoteId,
    invoiceId: invoice.id,
    branchId: options.branchId,
    number: plan.creditNote.formatted,
    prefix: plan.creditNote.prefix,
    financialYear: plan.creditNote.financialYear,
    sequenceNumber: plan.creditNote.number,
    creditNoteDate: plan.today,
    customerId: invoice.customerId,
    refundMethod: options.refundMethod,
    reason: options.reason,
    outsideWindow: plan.outsideWindow,
    taxablePaise: plan.taxablePaise,
    cgstPaise: plan.cgstPaise,
    sgstPaise: plan.sgstPaise,
    igstPaise: plan.igstPaise,
    taxPaise: plan.taxPaise,
    totalPaise: plan.totalPaise,
    roundOffPaise: plan.roundOffPaise,
    refundPaise: plan.refundPaise,
    exchangeInvoiceId: options.exchange?.invoiceId ?? null,
    exchangePaise: options.exchange?.appliedPaise ?? 0,
  });
  await repo.insertCreditNoteItems(
    tx,
    ctx,
    plan.lines.map((l) => ({
      id: l.id,
      creditNoteId: options.creditNoteId,
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
  for (const l of plan.lines) {
    if (l.item.serialNumberId !== null) await returnSerial(tx, l.item.serialNumberId, { branchId: options.branchId, resellable: l.resellable });
  }
  const movements: MovementInput[] = plan.lines
    .filter((l) => l.resellable)
    .map((l) => ({
      branchId: options.branchId,
      variantId: l.item.variantId,
      type: "SALE_RETURN_IN",
      quantity: l.quantity,
      unitCostPaise: l.item.unitCostPaise,
      sourceType: "credit_note",
      sourceId: options.creditNoteId,
      sourceLineId: l.id,
      ...(l.item.serialNumberId === null ? {} : { serialNumberId: l.item.serialNumberId }),
    }));
  if (movements.length > 0) await postMovements(tx, ctx, movements);

  if (options.refundMethod === "store_credit" && invoice.customerId !== null && leftoverPaise > 0) {
    await bookCustomerEntry(tx, ctx, { customerId: invoice.customerId, entryType: "return", amountPaise: -leftoverPaise, sourceType: "credit_note", sourceId: options.creditNoteId, note: plan.creditNote.formatted });
  }
  await repo.addAuditEntry(tx, ctx, {
    action: plan.outsideWindow ? "sales.return_after_window" : "sales.return_created",
    entityType: "credit_note",
    entityId: options.creditNoteId,
    before: null,
    after: {
      number: plan.creditNote.formatted,
      invoice: invoice.number,
      refundPaise: plan.refundPaise,
      refundMethod: options.refundMethod,
      exchangePaise: options.exchange?.appliedPaise ?? 0,
      lines: plan.lines.length,
      reason: options.reason,
    },
  });
}
