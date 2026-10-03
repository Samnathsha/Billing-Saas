import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auditLogs, memberships, partyLedgerEntries, roles } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { bookCustomerEntry, createCustomer, getCustomer, PartyError, setCustomerArchived } from "@/modules/parties";
import { listCustomerPayments, recordCustomerPayment } from "@/modules/sales";
import { listBranches } from "@/modules/tenants";
import { registerVerifiedUser } from "../helpers/auth";

// Customer payments (business rules 16): the balance goes down by exactly
// the amount, once per click; an advance when paying more; archived
// customers may still pay; who may; other businesses.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

async function newShop(label: string): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template: "clothing" });
  const r = await getRequestContext(owner.headers);
  if (r.kind !== "member") throw new Error("expected a member");
  return r.ctx;
}

async function memberWithRole(owner: TenantContext, role: string): Promise<TenantContext> {
  const user = await registerVerifiedUser(`Payment ${role}`);
  await withTenant(owner, async (tx) => {
    const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
    await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
  });
  const result = await getRequestContext(user.headers);
  if (result.kind !== "member") throw new Error("member");
  return result.ctx;
}

// A customer who owes `owes` paise (as after a credit sale).
async function owing(ctx: TenantContext, owes: number) {
  const { id } = await createCustomer(ctx, { name: `Owes ${String(owes)}`, phone: "", gstin: "", stateCode: "", creditLimitPaise: 1_000_000 });
  await withTenant(ctx, (tx) => bookCustomerEntry(tx, ctx, { customerId: id, entryType: "invoice", amountPaise: owes, sourceType: "invoice", sourceId: randomUUID(), note: null }));
  const branchId = (await listBranches(ctx))[0]?.id ?? "";
  return { customerId: id, branchId };
}

const pay = (c: { customerId: string; branchId: string }, amountPaise: number, extra: Record<string, unknown> = {}) => ({
  idempotencyKey: randomUUID(),
  ...c,
  method: "upi",
  amountPaise,
  reference: "UTR 42",
  ...extra,
});

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof PartyError || error instanceof PermissionDeniedError) return error.code;
    if (error instanceof ZodError) return `INVALID:${error.issues.map((i) => i.path.join(".")).join(",")}`;
    throw error;
  }
}

describe("customer payments", () => {
  it("lower the balance by exactly the amount; a retry records once; audited; listed", async () => {
    const ctx = await newShop("Pay basic");
    const c = await owing(ctx, 80_000);
    const input = pay(c, 30_000);
    const first = await recordCustomerPayment(ctx, input);
    expect(await recordCustomerPayment(ctx, input)).toEqual(first);
    expect((await getCustomer(ctx, { id: c.customerId })).balancePaise).toBe(50_000);
    expect(await listCustomerPayments(ctx, { customerId: c.customerId })).toEqual([
      expect.objectContaining({ id: first.paymentId, method: "upi", amountPaise: 30_000, reference: "UTR 42" }),
    ]);
    const entries = await withTenant(ctx, (tx) => tx.select({ type: partyLedgerEntries.entryType, amount: partyLedgerEntries.amountPaise }).from(partyLedgerEntries).where(eq(partyLedgerEntries.sourceId, first.paymentId)));
    expect(entries).toEqual([{ type: "payment", amount: -30_000 }]);
    const audit = await withTenant(ctx, (tx) => tx.select({ action: auditLogs.action, before: auditLogs.before }).from(auditLogs).where(eq(auditLogs.entityId, first.paymentId)));
    expect(audit).toEqual([{ action: "sales.customer_paid", before: { balancePaise: 80_000 } }]);
  });

  it("paying more than owed leaves an advance; an archived customer may still pay", async () => {
    const ctx = await newShop("Pay advance");
    const c = await owing(ctx, 10_000);
    await recordCustomerPayment(ctx, pay(c, 15_000, { method: "cash", reference: "" }));
    expect((await getCustomer(ctx, { id: c.customerId })).balancePaise).toBe(-5000);
    const d = await owing(ctx, 20_000);
    await setCustomerArchived(ctx, { id: d.customerId, archived: true });
    expect(await codeOf(recordCustomerPayment(ctx, pay(d, 20_000)))).toBe("ok");
    expect((await getCustomer(ctx, { id: d.customerId })).balancePaise).toBe(0);
  });

  it("checks the input", async () => {
    const ctx = await newShop("Pay checks");
    const c = await owing(ctx, 10_000);
    expect(await codeOf(recordCustomerPayment(ctx, pay(c, 0)))).toBe("INVALID:amountPaise");
    expect(await codeOf(recordCustomerPayment(ctx, pay(c, 1.5)))).toBe("INVALID:amountPaise");
    expect(await codeOf(recordCustomerPayment(ctx, pay(c, 100, { method: "gold" })))).toBe("INVALID:method");
    expect(await codeOf(recordCustomerPayment(ctx, pay(c, 100, { receivedOn: "2020-01-01" })))).toBe("INVALID:");
    expect((await getCustomer(ctx, { id: c.customerId })).balancePaise).toBe(10_000);
  });

  it("a cashier may take a payment; an accountant may only look", async () => {
    const owner = await newShop("Pay roles");
    const c = await owing(owner, 10_000);
    const cashier = await memberWithRole(owner, "Cashier");
    expect(await codeOf(recordCustomerPayment(cashier, pay(c, 4000)))).toBe("ok");
    const accountant = await memberWithRole(owner, "Accountant");
    expect(await codeOf(recordCustomerPayment(accountant, pay(c, 4000)))).toBe("FORBIDDEN");
    expect(await listCustomerPayments(accountant, { customerId: c.customerId })).toHaveLength(1);
    expect((await getCustomer(owner, { id: c.customerId })).balancePaise).toBe(6000);
  });

  it("another business cannot take or see payments for this business's customer", async () => {
    const a = await newShop("Pay A");
    const b = await newShop("Pay B");
    const cb = await owing(b, 10_000);
    const aBranch = (await listBranches(a))[0]?.id ?? "";
    expect(await codeOf(recordCustomerPayment(a, pay({ customerId: cb.customerId, branchId: aBranch }, 100)))).toBe("NOT_FOUND");
    expect(await codeOf(listCustomerPayments(a, { customerId: cb.customerId }))).toBe("NOT_FOUND");
    expect((await getCustomer(b, { id: cb.customerId })).balancePaise).toBe(10_000);
  });
});
