import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auditLogs, memberships, partyLedgerEntries, roles } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import {
  assertWithinCredit,
  bookCustomerEntry,
  createCustomer,
  getCustomer,
  listCustomers,
  lockCustomerForSale,
  PartyError,
  setCustomerArchived,
  updateCustomer,
} from "@/modules/parties";
import { gstinCheckChar } from "@/modules/tax/gst";
import { registerVerifiedUser } from "../helpers/auth";

// Basic customers (business rules 15): phone unique, GSTIN checked, credit
// limits only from managers, balance = ledger sum, credit checked under a
// lock, who may do what, other businesses.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

const KA_GSTIN = (() => {
  const first14 = "29ABCDE1234F1Z";
  return first14 + gstinCheckChar(first14);
})();

async function newShop(label: string): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template: "clothing" });
  const r = await getRequestContext(owner.headers);
  if (r.kind !== "member") throw new Error("expected a member");
  return r.ctx;
}

async function memberWithRole(owner: TenantContext, role: string): Promise<TenantContext> {
  const user = await registerVerifiedUser(`Customer ${role}`);
  await withTenant(owner, async (tx) => {
    const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
    await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
  });
  const result = await getRequestContext(user.headers);
  if (result.kind !== "member") throw new Error("member");
  return result.ctx;
}

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

const customer = (name: string, extra: Record<string, unknown> = {}) => ({ name, phone: "", gstin: "", stateCode: "", ...extra });

describe("customers", () => {
  it("a cashier adds a customer at the till; GSTIN sets the state; audited", async () => {
    const owner = await newShop("Customer add");
    const cashier = await memberWithRole(owner, "Cashier");
    const { id } = await createCustomer(cashier, customer(" Meena ", { phone: "98400 11111", gstin: KA_GSTIN.toLowerCase() }));
    expect(await getCustomer(cashier, { id })).toEqual({
      id,
      name: "Meena",
      phone: "98400 11111",
      gstin: KA_GSTIN,
      stateCode: "29",
      address: null,
      creditLimitPaise: 0,
      balancePaise: 0,
      active: true,
      version: 1,
    });
    const audit = await withTenant(owner, (tx) => tx.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, id)));
    expect(audit).toEqual([{ action: "parties.customer_created" }]);
  });

  it("one phone number, one customer; names may repeat", async () => {
    const ctx = await newShop("Customer phone");
    await createCustomer(ctx, customer("Ravi", { phone: "98400 22222" }));
    expect(await codeOf(createCustomer(ctx, customer("Ravi K", { phone: "98400 22222" })))).toBe("PHONE_TAKEN");
    expect(await codeOf(createCustomer(ctx, customer("Ravi")))).toBe("ok");
    expect(await codeOf(createCustomer(ctx, customer("No phone")))).toBe("ok");
  });

  it("checks the input", async () => {
    const ctx = await newShop("Customer checks");
    expect(await codeOf(createCustomer(ctx, customer("")))).toBe("INVALID:name");
    expect(await codeOf(createCustomer(ctx, customer("A", { phone: "call me" })))).toBe("INVALID:phone");
    expect(await codeOf(createCustomer(ctx, customer("B", { gstin: `${KA_GSTIN.slice(0, 14)}${KA_GSTIN.endsWith("A") ? "B" : "A"}` })))).toBe("INVALID:gstin");
    expect(await codeOf(createCustomer(ctx, customer("C", { creditLimitPaise: -1 })))).toBe("INVALID:creditLimitPaise");
    expect(await codeOf(createCustomer(ctx, customer("D", { creditLimitPaise: 1.5 })))).toBe("INVALID:creditLimitPaise");
    expect(await codeOf(createCustomer(ctx, { ...customer("E"), tenantId: randomUUID() }))).toBe("INVALID:");
  });

  it("only a manager or above sets or changes a credit limit", async () => {
    const owner = await newShop("Customer credit rights");
    const cashier = await memberWithRole(owner, "Cashier");
    const manager = await memberWithRole(owner, "Manager");
    expect(await codeOf(createCustomer(cashier, customer("Credit by cashier", { creditLimitPaise: 100 })))).toBe("FORBIDDEN");
    const { id } = await createCustomer(manager, customer("Credit by manager", { creditLimitPaise: 500_000 }));
    expect(await codeOf(updateCustomer(cashier, { id, version: 1, ...customer("Credit by manager", { creditLimitPaise: 900_000 }) }))).toBe("CREDIT_NOT_ALLOWED");
    expect(await codeOf(updateCustomer(cashier, { id, version: 1, ...customer("New name", { creditLimitPaise: 500_000 }) }))).toBe("ok");
    expect(await codeOf(updateCustomer(cashier, { id, version: 1, ...customer("Late", { creditLimitPaise: 500_000 }) }))).toBe("STALE");
    expect(await getCustomer(owner, { id })).toMatchObject({ name: "New name", creditLimitPaise: 500_000, version: 2 });
    expect(await codeOf(setCustomerArchived(cashier, { id, archived: true }))).toBe("FORBIDDEN");
    await setCustomerArchived(manager, { id, archived: true });
    expect(await listCustomers(owner)).toEqual([]);
    expect(await listCustomers(owner, { includeArchived: true })).toHaveLength(1);
  });

  it("credit: the balance is the ledger sum; a sale may not go over the limit; locked so two tills queue", async () => {
    const ctx = await newShop("Customer limit");
    const { id } = await createCustomer(ctx, customer("Udhaar", { phone: "98400 33333", creditLimitPaise: 100_000 }));
    await withTenant(ctx, async (tx) => {
      const c = await lockCustomerForSale(tx, id);
      assertWithinCredit(c, 60_000);
      await bookCustomerEntry(tx, ctx, { customerId: id, entryType: "invoice", amountPaise: 60_000, sourceType: "invoice", sourceId: randomUUID(), note: null });
    });
    expect((await getCustomer(ctx, { id })).balancePaise).toBe(60_000);
    await withTenant(ctx, async (tx) => {
      const c = await lockCustomerForSale(tx, id);
      expect(() => { assertWithinCredit(c, 40_001); }).toThrow(PartyError);
      assertWithinCredit(c, 40_000);
      assertWithinCredit(c, 0);
    });
    expect((await listCustomers(ctx, { q: "33333" }))[0]?.balancePaise).toBe(60_000);
    const rows = await withTenant(ctx, (tx) => tx.select({ customerId: partyLedgerEntries.customerId, supplierId: partyLedgerEntries.supplierId }).from(partyLedgerEntries));
    expect(rows).toEqual([{ customerId: id, supplierId: null }]);
  });

  it("an archived customer cannot buy on credit", async () => {
    const ctx = await newShop("Customer archived");
    const { id } = await createCustomer(ctx, customer("Gone"));
    await setCustomerArchived(ctx, { id, archived: true });
    expect(await codeOf(withTenant(ctx, (tx) => lockCustomerForSale(tx, id)))).toBe("ARCHIVED");
  });

  it("a ledger row names exactly one party", async () => {
    const ctx = await newShop("Customer one party");
    await expect(
      withTenant(ctx, (tx) => tx.insert(partyLedgerEntries).values({ tenantId: ctx.tenantId, entryType: "invoice", amountPaise: 1, sourceType: "x", sourceId: randomUUID(), createdBy: ctx.userId })),
    ).rejects.toThrow();
  });
});

describe("another business", () => {
  it("cannot see, change or book against another business's customer", async () => {
    const a = await newShop("Customer A");
    const b = await newShop("Customer B");
    const { id } = await createCustomer(b, customer("Private", { phone: "98400 44444" }));
    expect(await listCustomers(a, { includeArchived: true })).toEqual([]);
    expect(await codeOf(getCustomer(a, { id }))).toBe("NOT_FOUND");
    expect(await codeOf(updateCustomer(a, { id, version: 1, ...customer("Hacked") }))).toBe("NOT_FOUND");
    expect(await codeOf(setCustomerArchived(a, { id, archived: true }))).toBe("NOT_FOUND");
    expect(await codeOf(withTenant(a, (tx) => lockCustomerForSale(tx, id)))).toBe("NOT_FOUND");
    // The same phone is fine in another business.
    expect(await codeOf(createCustomer(a, customer("Mine", { phone: "98400 44444" })))).toBe("ok");
    expect(await getCustomer(b, { id })).toMatchObject({ name: "Private", active: true });
  });
});
