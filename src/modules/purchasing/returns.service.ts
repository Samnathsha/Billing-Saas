import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { quantityToMilli } from "@/lib/bill-maths";
import { returnAmounts } from "@/lib/return-maths";
import { requirePermission, type Permission } from "@/modules/auth";
import { inStockSerialsOfPurchaseItem, postMovements, sendSerialsBack, type MovementInput } from "@/modules/inventory";
import { bookSupplierEntry } from "@/modules/parties";
import { claimIdempotencyKey } from "@/modules/sync";
import { PurchaseError } from "./errors";
import * as repo from "./repo";

// Goods back to the supplier (business rules 16; open question 42) as ONE
// transaction with an idempotency key: the purchase is locked (returns
// against it happen one at a time), never more than bought minus earlier
// returns, amounts reverse the purchase's own lines exactly (partial
// returns add up to the line), stock goes out at the current average cost,
// IMEIs must have come in on that line and still be here, what we owe the
// supplier goes down, audited.

const VIEW: readonly Permission[] = ["purchases.create", "reports.view"];
const QTY = /^\d{1,11}(\.\d{1,3})?$/;
const SERIAL = /^[A-Za-z0-9-]{4,40}$/;

export const createPurchaseReturnInput = z.strictObject({
  idempotencyKey: z.uuid(),
  purchaseId: z.uuid(),
  reason: z.string().trim().min(3, { error: "Say why the goods go back." }).max(500),
  reference: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(40).nullable()).default(null),
  lines: z
    .array(
      z.strictObject({
        purchaseItemId: z.uuid(),
        quantity: z.string().trim().regex(QTY, { error: "Enter a quantity (at most 3 decimals)." }),
        serials: z.array(z.string().trim().regex(SERIAL)).max(500).default([]),
      }),
    )
    .min(1, { error: "Choose at least one item to send back." })
    .max(200),
});

export interface PurchaseReturnableDto {
  purchaseId: string;
  supplierInvoiceNumber: string;
  status: "posted" | "voided";
  lines: { purchaseItemId: string; lineNumber: number; variantId: string; quantity: string; returned: string; remaining: string; totalPaise: number; serialsInStock: string[] }[];
  returns: { id: string; returnDate: string; totalPaise: number; reason: string; reference: string | null }[];
}

const milliText = (milli: bigint): string => `${String(milli / 1000n)}.${String(milli % 1000n).padStart(3, "0")}`;
const todayIn = (timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export async function createPurchaseReturn(ctx: TenantContext, rawInput: unknown): Promise<{ purchaseReturnId: string }> {
  await requirePermission(ctx, "purchases.create");
  const input = createPurchaseReturnInput.parse(rawInput);
  const purchaseReturnId = randomUUID();
  return withTenant(ctx, async (tx) => {
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "purchases.return", { purchaseReturnId });
    if (!claim.claimed) return claim.result;

    const purchase = await repo.lockPurchase(tx, input.purchaseId);
    if (purchase === undefined) throw new PurchaseError("NOT_FOUND");
    if (purchase.status !== "posted") throw new PurchaseError("ALREADY_VOIDED");
    const items = new Map((await repo.itemsOf(tx, purchase.id)).map((i) => [i.id, i]));
    const returned = await repo.returnedQuantities(tx, purchase.id);
    if (new Set(input.lines.map((l) => l.purchaseItemId)).size !== input.lines.length) throw new PurchaseError("RETURN_TOO_MANY");

    const lines = input.lines.map((l, index) => {
      const item = items.get(l.purchaseItemId);
      if (item === undefined) throw new PurchaseError("NOT_FOUND");
      const bought = quantityToMilli(item.quantity);
      const already = quantityToMilli(returned.get(item.id) ?? "0");
      const now = quantityToMilli(l.quantity);
      if (now === 0n) throw new PurchaseError("ZERO_QUANTITY");
      if (already + now > bought) throw new PurchaseError("RETURN_TOO_MANY");
      // A purchase line has one GST amount (no split): it plays the IGST part.
      const amounts = returnAmounts({ taxablePaise: item.lineSubtotalPaise, cgstPaise: 0, igstPaise: item.lineTaxPaise }, bought, already, now);
      return { id: randomUUID(), lineNumber: index + 1, item, quantity: milliText(now), serials: l.serials, subtotalPaise: amounts.taxablePaise, taxPaise: amounts.igstPaise, totalPaise: amounts.totalPaise };
    });
    const subtotalPaise = lines.reduce((s, l) => s + l.subtotalPaise, 0);
    const taxPaise = lines.reduce((s, l) => s + l.taxPaise, 0);
    const totalPaise = subtotalPaise + taxPaise;
    const business = await repo.businessFacts(tx);

    await repo.insertReturn(tx, ctx, {
      id: purchaseReturnId,
      purchaseId: purchase.id,
      supplierId: purchase.supplierId,
      branchId: purchase.branchId,
      returnDate: todayIn(business.timeZone),
      reference: input.reference,
      reason: input.reason,
      subtotalPaise,
      taxPaise,
      totalPaise,
    });
    await repo.insertReturnItems(
      tx,
      ctx,
      lines.map((l) => ({
        id: l.id,
        purchaseReturnId,
        lineNumber: l.lineNumber,
        purchaseItemId: l.item.id,
        variantId: l.item.variantId,
        quantity: l.quantity,
        subtotalPaise: l.subtotalPaise,
        taxPaise: l.taxPaise,
        totalPaise: l.totalPaise,
      })),
    );

    // Stock out of the purchase's branch; IMEI items one movement per phone.
    const movements: MovementInput[] = [];
    for (const l of lines) {
      const common = { branchId: purchase.branchId, variantId: l.item.variantId, type: "PURCHASE_RETURN_OUT" as const, sourceType: "purchase_return", sourceId: purchaseReturnId, sourceLineId: l.id };
      if (l.serials.length === 0) {
        movements.push({ ...common, quantity: `-${l.quantity}` });
        continue;
      }
      if (BigInt(l.serials.length) * 1000n !== quantityToMilli(l.quantity)) throw new PurchaseError("SERIAL_COUNT");
      const ids = await sendSerialsBack(tx, { purchaseItemId: l.item.id, variantId: l.item.variantId, branchId: purchase.branchId, serials: l.serials });
      for (const serialNumberId of ids) movements.push({ ...common, quantity: "-1", serialNumberId });
    }
    await postMovements(tx, ctx, movements);

    if (totalPaise > 0) {
      await bookSupplierEntry(tx, ctx, { supplierId: purchase.supplierId, entryType: "purchase_return", amountPaise: -totalPaise, sourceType: "purchase_return", sourceId: purchaseReturnId, note: input.reference ?? input.reason });
    }
    await repo.addAuditEntry(tx, ctx, {
      action: "purchases.returned",
      entityType: "purchase_return",
      entityId: purchaseReturnId,
      before: null,
      after: { purchaseId: purchase.id, bill: purchase.supplierInvoiceNumber, totalPaise, lines: lines.length, reason: input.reason },
    });
    return { purchaseReturnId };
  });
}

export async function getPurchaseReturnable(ctx: TenantContext, rawInput: unknown): Promise<PurchaseReturnableDto> {
  await requirePermission(ctx, VIEW);
  const { purchaseId } = z.strictObject({ purchaseId: z.uuid() }).parse(rawInput);
  return withTenant(ctx, async (tx) => {
    const purchase = await repo.findPurchase(tx, purchaseId);
    if (purchase === undefined) throw new PurchaseError("NOT_FOUND");
    const items = await repo.itemsOf(tx, purchaseId);
    const returned = await repo.returnedQuantities(tx, purchaseId);
    const lines = [];
    for (const i of items) {
      const bought = quantityToMilli(i.quantity);
      const back = quantityToMilli(returned.get(i.id) ?? "0");
      lines.push({
        purchaseItemId: i.id,
        lineNumber: i.lineNumber,
        variantId: i.variantId,
        quantity: milliText(bought),
        returned: milliText(back),
        remaining: milliText(bought - back),
        totalPaise: i.lineTotalPaise,
        serialsInStock: await inStockSerialsOfPurchaseItem(tx, i.id),
      });
    }
    return {
      purchaseId,
      supplierInvoiceNumber: purchase.supplierInvoiceNumber,
      status: purchase.status === "voided" ? "voided" : "posted",
      lines,
      returns: await repo.returnsOf(tx, purchaseId),
    };
  });
}
