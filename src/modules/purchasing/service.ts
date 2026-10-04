import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantContext, type TenantTx } from "@/db/with-tenant";
import { hasPermission, requirePermission, type Permission } from "@/modules/auth";
import { assertStockTargets, postMovements, receiveSerials, reverseStockOf, type MovementInput } from "@/modules/inventory";
import { bookSupplierEntry, lockSupplierFor } from "@/modules/parties";
import { claimIdempotencyKey } from "@/modules/sync";
import { PurchaseError } from "./errors";
import { purchaseLineAmounts } from "./maths";
import * as repo from "./repo";

// Purchases and supplier payments (blueprint Phase 6; business rules 14).
// Posting a purchase is ONE transaction: idempotency key, the bill and its
// lines, stock in (postMovements), IMEI numbers, the supplier's account, an
// optional payment, and the audit entry. A posted purchase is never edited:
// a Manager or above voids the whole bill, which reverses its stock and the
// supplier's account; money already paid stays paid (it becomes an advance
// with the supplier).

const VIEW: readonly Permission[] = ["purchases.create", "reports.view"];
const MAX_PAISE = 100_000_000_000; // ₹100 crore
const QTY_POSITIVE = /^\d{1,11}(\.\d{1,3})?$/;
const RATE = /^\d{1,3}(\.\d{1,4})?$/;
const SERIAL = /^[A-Za-z0-9-]{4,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const METHODS = ["cash", "upi", "bank", "cheque"] as const;

const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullable()).default(null);

// A real calendar day on or after 1 July 2017 (GST began).
const day = z
  .string()
  .regex(DATE, { error: "Enter a date." })
  .refine((v) => v >= "2017-07-01" && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), { error: "Enter a valid date." });

const payment = z.strictObject({
  amountPaise: z.int().min(1).max(MAX_PAISE),
  method: z.enum(METHODS),
  reference: optionalText(100),
});

export const createPurchaseInput = z.strictObject({
  idempotencyKey: z.uuid(),
  supplierId: z.uuid(),
  branchId: z.uuid(),
  supplierInvoiceNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9/\-_. #]{1,40}$/, { error: "Bill number: 1 to 40 letters, digits or / - _ . #" }),
  invoiceDate: day,
  note: optionalText(500),
  lines: z
    .array(
      z.strictObject({
        variantId: z.uuid(),
        quantity: z.string().trim().regex(QTY_POSITIVE, { error: "Enter a quantity (at most 3 decimals)." }),
        // Supplier's price per unit BEFORE GST.
        unitPricePaise: z.int().min(0).max(1_000_000_000),
        // GST % on the supplier's bill, e.g. "18" or "0.25".
        taxRate: z
          .string()
          .trim()
          .regex(RATE, { error: "Enter the GST rate, e.g. 18." })
          .refine((v) => Number(v) <= 100, { error: "Enter the GST rate, e.g. 18." }),
        serials: z.array(z.string().trim().regex(SERIAL, { error: "IMEI/serial: 4 to 40 letters, digits or -" })).max(500).default([]),
      }),
    )
    .min(1, { error: "Add at least one item." })
    .max(200),
  // Money paid to the supplier together with this bill (optional).
  payment: payment.nullable().default(null),
});

export const voidPurchaseInput = z.strictObject({
  idempotencyKey: z.uuid(),
  purchaseId: z.uuid(),
  reason: z.string().trim().min(3, { error: "Say why this purchase is voided." }).max(500),
});

export const supplierPaymentInput = z.strictObject({
  idempotencyKey: z.uuid(),
  supplierId: z.uuid(),
  paidOn: day,
  ...payment.shape,
});

export interface PurchaseDto {
  id: string;
  supplierId: string;
  supplierName: string;
  branchId: string;
  supplierInvoiceNumber: string;
  invoiceDate: string;
  status: "posted" | "voided";
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  paidPaise: number;
  costBasis: "excludes_tax" | "includes_tax";
  note: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  createdAt: string;
}

export interface PurchaseDetailDto extends PurchaseDto {
  items: {
    lineNumber: number;
    variantId: string;
    quantity: string;
    unitPricePaise: number;
    taxRate: string;
    subtotalPaise: number;
    taxPaise: number;
    totalPaise: number;
    // Only for "View cost price and profit".
    unitCostPaise?: string;
  }[];
}

// Today in the business's time zone, as YYYY-MM-DD.
const todayIn = (timeZone: string): string => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const isUniqueViolation = (error: unknown): boolean => {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return cause instanceof Error && "code" in cause && cause.code === "23505";
};

async function payInside(
  tx: TenantTx,
  ctx: TenantContext,
  values: { id: string; supplierId: string; purchaseId: string | null; amountPaise: number; method: string; reference: string | null; paidOn: string },
): Promise<void> {
  await repo.insertPayment(tx, ctx, values);
  await bookSupplierEntry(tx, ctx, { supplierId: values.supplierId, entryType: "payment", amountPaise: -values.amountPaise, sourceType: "supplier_payment", sourceId: values.id, note: values.reference });
}

export async function createPurchase(ctx: TenantContext, rawInput: unknown): Promise<{ purchaseId: string }> {
  await requirePermission(ctx, "purchases.create");
  const input = createPurchaseInput.parse(rawInput);
  const purchaseId = randomUUID();
  return withTenant(ctx, async (tx) => {
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "purchases.create", { purchaseId });
    if (!claim.claimed) return claim.result;

    const business = await repo.businessFacts(tx);
    if (business.gstRegistration === null) throw new PurchaseError("REGISTRATION_NOT_SET");
    // Rule 14: a regular GST registration claims the GST back, so it is not cost.
    const costBasis = business.gstRegistration === "registered" ? "excludes_tax" : "includes_tax";
    if (input.invoiceDate > todayIn(business.timeZone)) throw new PurchaseError("DATE_IN_FUTURE");
    await lockSupplierFor(tx, input.supplierId, "purchase");
    await assertStockTargets(tx, input.lines.map((l) => l.variantId), input.branchId);
    if (await repo.billNumberTaken(tx, input.supplierId, input.supplierInvoiceNumber)) throw new PurchaseError("DUPLICATE_BILL");

    const lines = input.lines.map((line, index) => {
      if (line.serials.length > 0 && line.serials.length !== Number(line.quantity)) throw new PurchaseError("SERIAL_COUNT");
      if (Number(line.quantity) === 0) throw new PurchaseError("ZERO_QUANTITY");
      return { ...line, id: randomUUID(), lineNumber: index + 1, amounts: purchaseLineAmounts({ ...line, costBasis }) };
    });
    const subtotalPaise = lines.reduce((sum, l) => sum + l.amounts.subtotalPaise, 0);
    const taxPaise = lines.reduce((sum, l) => sum + l.amounts.taxPaise, 0);
    const totalPaise = subtotalPaise + taxPaise;
    if (totalPaise > MAX_PAISE) throw new PurchaseError("TOTAL_TOO_LARGE");
    if (input.payment !== null && input.payment.amountPaise > totalPaise) throw new PurchaseError("PAYMENT_ABOVE_TOTAL");

    try {
      await repo.insertPurchase(tx, ctx, {
        id: purchaseId,
        supplierId: input.supplierId,
        branchId: input.branchId,
        supplierInvoiceNumber: input.supplierInvoiceNumber,
        invoiceDate: input.invoiceDate,
        subtotalPaise,
        taxPaise,
        totalPaise,
        costBasis,
        note: input.note,
      });
    } catch (error) {
      // Two people entering the same bill at the same moment.
      if (isUniqueViolation(error)) throw new PurchaseError("DUPLICATE_BILL");
      throw error;
    }
    await repo.insertItems(
      tx,
      ctx,
      lines.map((l) => ({
        id: l.id,
        purchaseId,
        lineNumber: l.lineNumber,
        variantId: l.variantId,
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
        taxRate: l.taxRate,
        lineSubtotalPaise: l.amounts.subtotalPaise,
        lineTaxPaise: l.amounts.taxPaise,
        lineTotalPaise: l.amounts.totalPaise,
        unitCostPaise: l.amounts.unitCostPaise,
      })),
    );

    const movements: MovementInput[] = [];
    for (const l of lines) {
      const common = { branchId: input.branchId, variantId: l.variantId, type: "PURCHASE_IN" as const, unitCostPaise: l.amounts.unitCostPaise, sourceType: "purchase", sourceId: purchaseId, sourceLineId: l.id };
      if (l.serials.length === 0) {
        movements.push({ ...common, quantity: l.quantity });
        continue;
      }
      const serialIds = await receiveSerials(tx, ctx, { variantId: l.variantId, branchId: input.branchId, serials: l.serials, purchaseItemId: l.id });
      for (const serialNumberId of serialIds) movements.push({ ...common, quantity: "1", serialNumberId });
    }
    await postMovements(tx, ctx, movements);

    if (totalPaise > 0) {
      await bookSupplierEntry(tx, ctx, { supplierId: input.supplierId, entryType: "purchase", amountPaise: totalPaise, sourceType: "purchase", sourceId: purchaseId, note: input.supplierInvoiceNumber });
    }
    if (input.payment !== null) {
      await payInside(tx, ctx, { id: randomUUID(), supplierId: input.supplierId, purchaseId, ...input.payment, paidOn: input.invoiceDate });
    }
    await repo.addAuditEntry(tx, ctx, {
      action: "purchases.created",
      entityType: "purchase",
      entityId: purchaseId,
      before: null,
      after: { ...input, costBasis, subtotalPaise, taxPaise, totalPaise },
    });
    return { purchaseId };
  });
}

export async function voidPurchase(ctx: TenantContext, rawInput: unknown): Promise<{ purchaseId: string }> {
  await requirePermission(ctx, "purchases.create");
  // Rule 14: Manager or above ("Void a posted invoice").
  await requirePermission(ctx, "invoices.void");
  const input = voidPurchaseInput.parse(rawInput);
  return withTenant(ctx, async (tx) => {
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "purchases.void", { purchaseId: input.purchaseId });
    if (!claim.claimed) return claim.result;

    const purchase = await repo.lockPurchase(tx, input.purchaseId);
    if (purchase === undefined) throw new PurchaseError("NOT_FOUND");
    if (purchase.status !== "posted") throw new PurchaseError("ALREADY_VOIDED");
    if (await repo.hasReturns(tx, purchase.id)) throw new PurchaseError("RETURNS_EXIST");
    // Refused (and nothing changes) if any of this stock is no longer there.
    await reverseStockOf(tx, ctx, { sourceType: "purchase", sourceId: purchase.id, reversalSourceType: "purchase_void", note: input.reason });
    if (purchase.totalPaise > 0) {
      await bookSupplierEntry(tx, ctx, {
        supplierId: purchase.supplierId,
        entryType: "void_reversal",
        amountPaise: -purchase.totalPaise,
        sourceType: "purchase",
        sourceId: purchase.id,
        note: input.reason,
      });
    }
    await repo.markVoided(tx, ctx, purchase.id, input.reason);
    await repo.addAuditEntry(tx, ctx, {
      action: "purchases.voided",
      entityType: "purchase",
      entityId: purchase.id,
      before: { status: "posted" },
      after: { status: "voided", reason: input.reason },
    });
    return { purchaseId: purchase.id };
  });
}

export async function recordSupplierPayment(ctx: TenantContext, rawInput: unknown): Promise<{ paymentId: string }> {
  await requirePermission(ctx, "purchases.create");
  const input = supplierPaymentInput.parse(rawInput);
  const paymentId = randomUUID();
  return withTenant(ctx, async (tx) => {
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "purchases.supplier_payment", { paymentId });
    if (!claim.claimed) return claim.result;
    const business = await repo.businessFacts(tx);
    if (input.paidOn > todayIn(business.timeZone)) throw new PurchaseError("DATE_IN_FUTURE");
    await lockSupplierFor(tx, input.supplierId, "payment");
    await payInside(tx, ctx, { id: paymentId, supplierId: input.supplierId, purchaseId: null, amountPaise: input.amountPaise, method: input.method, reference: input.reference, paidOn: input.paidOn });
    await repo.addAuditEntry(tx, ctx, { action: "purchases.supplier_paid", entityType: "supplier_payment", entityId: paymentId, before: null, after: input });
    return { paymentId };
  });
}

const toDto = (row: NonNullable<Awaited<ReturnType<typeof repo.findPurchase>>>): PurchaseDto => ({
  id: row.id,
  supplierId: row.supplierId,
  supplierName: row.supplierName,
  branchId: row.branchId,
  supplierInvoiceNumber: row.supplierInvoiceNumber,
  invoiceDate: row.invoiceDate,
  status: row.status === "voided" ? "voided" : "posted",
  subtotalPaise: row.subtotalPaise,
  taxPaise: row.taxPaise,
  totalPaise: row.totalPaise,
  paidPaise: Number(row.paidPaise),
  costBasis: row.costBasis === "includes_tax" ? "includes_tax" : "excludes_tax",
  note: row.note,
  voidReason: row.voidReason,
  voidedAt: row.voidedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

export async function listPurchases(ctx: TenantContext, rawInput: unknown = {}): Promise<PurchaseDto[]> {
  await requirePermission(ctx, VIEW);
  const input = z.strictObject({ supplierId: z.uuid().nullable().default(null) }).parse(rawInput);
  const rows = await withTenant(ctx, (tx) => repo.listPurchases(tx, input));
  return rows.map(toDto);
}

export async function getPurchase(ctx: TenantContext, rawInput: unknown): Promise<PurchaseDetailDto> {
  await requirePermission(ctx, VIEW);
  const { purchaseId } = z.strictObject({ purchaseId: z.uuid() }).parse(rawInput);
  const showCost = await hasPermission(ctx, "costs.view");
  return withTenant(ctx, async (tx) => {
    const row = await repo.findPurchase(tx, purchaseId);
    if (row === undefined) throw new PurchaseError("NOT_FOUND");
    const items = await repo.itemsOf(tx, purchaseId);
    return {
      ...toDto(row),
      items: items.map((i) => ({
        lineNumber: i.lineNumber,
        variantId: i.variantId,
        quantity: i.quantity,
        unitPricePaise: i.unitPricePaise,
        taxRate: i.taxRate,
        subtotalPaise: i.lineSubtotalPaise,
        taxPaise: i.lineTaxPaise,
        totalPaise: i.lineTotalPaise,
        ...(showCost ? { unitCostPaise: i.unitCostPaise } : {}),
      })),
    };
  });
}
