import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { requirePermission, type Permission } from "@/modules/auth";
import { bookCustomerEntry, lockCustomerForSale } from "@/modules/parties";
import { claimIdempotencyKey } from "@/modules/sync";
import * as repo from "./repo";
import { SalesError } from "./service";

// A customer paying what they owe (business rules 16): one transaction with
// an idempotency key; the payment row and a negative ledger row (append-
// only), audited. Dated today in the business's time zone. Paying more than
// owed leaves an advance (open question 41).

const VIEW: readonly Permission[] = ["sales.create", "reports.view", "invoices.void"];

export const customerPaymentInput = z.strictObject({
  idempotencyKey: z.uuid(),
  customerId: z.uuid(),
  branchId: z.uuid(),
  method: z.enum(["cash", "card", "upi"], { error: "Choose how it was paid." }),
  amountPaise: z.int({ error: "Enter the amount in paise." }).min(1, { error: "Enter an amount above zero." }).max(100_000_000_000),
  reference: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(100).nullable()).default(null),
});

export interface CustomerPaymentDto {
  id: string;
  customerId: string;
  customerName: string;
  method: "cash" | "card" | "upi";
  amountPaise: number;
  reference: string | null;
  receivedOn: string;
  createdAt: string;
}

const todayIn = (timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const method = (m: string): "cash" | "card" | "upi" => (m === "card" || m === "upi" ? m : "cash");

export async function recordCustomerPayment(ctx: TenantContext, rawInput: unknown): Promise<{ paymentId: string }> {
  await requirePermission(ctx, "sales.create");
  const input = customerPaymentInput.parse(rawInput);
  const paymentId = randomUUID();
  return withTenant(ctx, async (tx) => {
    const claim = await claimIdempotencyKey(tx, ctx, input.idempotencyKey, "sales.customer_payment", { paymentId });
    if (!claim.claimed) return claim.result;
    const settings = await repo.saleSettings(tx);
    if (settings === undefined) throw new SalesError("SETTINGS_INCOMPLETE");
    const customer = await lockCustomerForSale(tx, input.customerId, "payment");
    await repo.insertCustomerPayment(tx, ctx, {
      id: paymentId,
      customerId: customer.id,
      branchId: input.branchId,
      method: input.method,
      amountPaise: input.amountPaise,
      reference: input.reference,
      receivedOn: todayIn(settings.timeZone),
    });
    await bookCustomerEntry(tx, ctx, { customerId: customer.id, entryType: "payment", amountPaise: -input.amountPaise, sourceType: "customer_payment", sourceId: paymentId, note: input.reference });
    await repo.addAuditEntry(tx, ctx, {
      action: "sales.customer_paid",
      entityType: "customer_payment",
      entityId: paymentId,
      before: { balancePaise: customer.balancePaise },
      after: { customerId: customer.id, amountPaise: input.amountPaise, method: input.method, balancePaise: customer.balancePaise - input.amountPaise },
    });
    return { paymentId };
  });
}

export async function listCustomerPayments(ctx: TenantContext, rawInput: unknown): Promise<CustomerPaymentDto[]> {
  await requirePermission(ctx, VIEW);
  const { customerId } = z.strictObject({ customerId: z.uuid() }).parse(rawInput);
  return withTenant(ctx, async (tx) => {
    const customer = await lockCustomerForSale(tx, customerId, "payment");
    const rows = await repo.customerPaymentsOf(tx, customerId);
    return rows.map((r) => ({
      id: r.id,
      customerId: r.customerId,
      customerName: customer.name,
      method: method(r.method),
      amountPaise: r.amountPaise,
      reference: r.reference,
      receivedOn: r.receivedOn,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}
