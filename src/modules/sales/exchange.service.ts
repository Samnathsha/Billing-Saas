import "server-only";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { hasPermission, requirePermission } from "@/modules/auth";
import { claimIdempotencyKey } from "@/modules/sync";
import { planReturn, writeReturn } from "./return-core";
import { createReturnInput } from "./returns.service";
import { postSale } from "./sale-core";
import { createSaleInput } from "./service";

// An exchange (blueprint 7.6; business rules 16): a return and a new sale in
// ONE transaction. The value of the returned items pays the new bill first
// (an "exchange" payment naming the credit note); the customer pays any
// difference, or gets the leftover back as money or store credit. If
// anything fails, neither the return nor the sale is saved.

const returnPart = createReturnInput.pick({ creditNoteId: true, invoiceId: true, reason: true, lines: true });
const salePart = createSaleInput.pick({ lines: true, billDiscountPaise: true, payments: true, expectedPayablePaise: true });

export const createExchangeInput = z.strictObject({
  idempotencyKey: z.uuid(),
  branchId: z.uuid(),
  return: returnPart,
  sale: salePart.extend({
    // The new bill's id, made on the device.
    invoiceId: z.uuid(),
    // Empty = the customer of the original bill.
    customerId: z.uuid().nullable().default(null),
  }),
  // When the returned items are worth more than the new bill.
  leftoverMethod: z.enum(["cash", "card", "upi", "store_credit"], { error: "Choose how the difference goes back." }).default("cash"),
});

export async function createExchange(ctx: TenantContext, rawInput: unknown): Promise<{ creditNoteId: string; invoiceId: string }> {
  await requirePermission(ctx, "sales.create");
  const input = createExchangeInput.parse(rawInput);
  const mayPassWindow = await hasPermission(ctx, "invoices.void");
  const unlimitedDiscount = await hasPermission(ctx, "discounts.above_limit");
  return withTenant(ctx, async (tx) => {
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "sales.exchange", { creditNoteId: input.return.creditNoteId, invoiceId: input.sale.invoiceId });
    if (!claim.claimed) return claim.result;

    const plan = await planReturn(tx, ctx, input.return, { mayPassWindow });
    const sale = await postSale(
      tx,
      ctx,
      { ...input.sale, idempotencyKey: input.idempotencyKey, branchId: input.branchId, customerId: input.sale.customerId ?? plan.invoice.customerId },
      { unlimitedDiscount, exchange: { creditPaise: plan.refundPaise, reference: plan.creditNote.formatted } },
    );
    const leftover = plan.refundPaise - sale.exchangeAppliedPaise;
    await writeReturn(tx, ctx, plan, {
      creditNoteId: input.return.creditNoteId,
      branchId: input.branchId,
      reason: input.return.reason,
      refundMethod: leftover > 0 ? input.leftoverMethod : "exchange",
      exchange: { invoiceId: input.sale.invoiceId, appliedPaise: sale.exchangeAppliedPaise },
    });
    return { creditNoteId: input.return.creditNoteId, invoiceId: input.sale.invoiceId };
  });
}
