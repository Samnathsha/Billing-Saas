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
  createSupplier,
  getSupplierStatement,
  listSuppliers,
  PartyError,
  recordSupplierOpeningBalance,
  setSupplierArchived,
  updateSupplier,
} from "@/modules/parties";
import { gstinCheckChar } from "@/modules/tax/gst";
import { registerVerifiedUser } from "../helpers/auth";

// Suppliers: names unique per business, GSTIN checked and setting the
// state, archived not deleted, balance = sum of the append-only ledger,
// opening balance once, who may do what, other businesses.

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
  const user = await registerVerifiedUser(`Supplier ${role}`);
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

const supplier = (name: string, extra: Record<string, unknown> = {}) => ({ name, phone: "", gstin: "", stateCode: "", ...extra });

describe("suppliers", () => {
  it("creates a supplier; the state comes from the GSTIN; the change is audited", async () => {
    const ctx = await newShop("Supplier create");
    const { id } = await createSupplier(ctx, supplier("  Ravi Traders ", { phone: "98400 12345", gstin: ` ${KA_GSTIN.toLowerCase()} ` }));
    const [row] = await listSuppliers(ctx);
    expect(row).toEqual({ id, name: "Ravi Traders", phone: "98400 12345", gstin: KA_GSTIN, stateCode: "29", active: true, version: 1, balancePaise: 0 });
    const audit = await withTenant(ctx, (tx) => tx.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, id)));
    expect(audit).toEqual([{ action: "parties.supplier_created" }]);
  });

  it("names are unique ignoring case, archived ones included", async () => {
    const ctx = await newShop("Supplier names");
    const { id } = await createSupplier(ctx, supplier("Sri Balaji Agencies"));
    expect(await codeOf(createSupplier(ctx, supplier("SRI BALAJI agencies")))).toBe("NAME_TAKEN");
    await setSupplierArchived(ctx, { id, archived: true });
    expect(await codeOf(createSupplier(ctx, supplier("sri balaji agencies")))).toBe("NAME_TAKEN");
  });

  it("checks the GSTIN, phone and state", async () => {
    const ctx = await newShop("Supplier checks");
    const wrongCheck = KA_GSTIN.slice(0, 14) + (KA_GSTIN.endsWith("A") ? "B" : "A");
    expect(await codeOf(createSupplier(ctx, supplier("A", { gstin: wrongCheck })))).toBe("INVALID:gstin");
    expect(await codeOf(createSupplier(ctx, supplier("B", { gstin: "29ABCDE1234F1" })))).toBe("INVALID:gstin");
    expect(await codeOf(createSupplier(ctx, supplier("C", { gstin: KA_GSTIN, stateCode: "33" })))).toBe("INVALID:stateCode");
    expect(await codeOf(createSupplier(ctx, supplier("D", { stateCode: "99" })))).toBe("INVALID:stateCode");
    expect(await codeOf(createSupplier(ctx, supplier("E", { phone: "call me" })))).toBe("INVALID:phone");
    expect(await codeOf(createSupplier(ctx, supplier("")))).toBe("INVALID:name");
    expect(await codeOf(createSupplier(ctx, { ...supplier("F"), tenantId: randomUUID() }))).toBe("INVALID:");
    expect(await codeOf(createSupplier(ctx, supplier("G", { stateCode: "33" })))).toBe("ok");
  });

  it("edits with a version check; archive and restore", async () => {
    const ctx = await newShop("Supplier edit");
    const { id } = await createSupplier(ctx, supplier("Old Name"));
    await createSupplier(ctx, supplier("Taken Name"));
    expect(await codeOf(updateSupplier(ctx, { id, version: 1, ...supplier("Taken name") }))).toBe("NAME_TAKEN");
    expect(await codeOf(updateSupplier(ctx, { id, version: 1, ...supplier("New Name", { phone: "+91 98400 00000" }) }))).toBe("ok");
    expect(await codeOf(updateSupplier(ctx, { id, version: 1, ...supplier("Late Edit") }))).toBe("STALE");
    expect(await codeOf(updateSupplier(ctx, { id, version: 2, ...supplier("new name") }))).toBe("ok");
    await setSupplierArchived(ctx, { id, archived: true });
    expect((await listSuppliers(ctx)).map((s) => s.name)).toEqual(["Taken Name"]);
    expect((await listSuppliers(ctx, { includeArchived: true })).find((s) => s.id === id)).toMatchObject({ name: "new name", active: false });
    await setSupplierArchived(ctx, { id, archived: false });
    expect((await listSuppliers(ctx, { q: "NEW" })).map((s) => s.id)).toEqual([id]);
    expect(await listSuppliers(ctx, { q: "%" })).toEqual([]);
  });

  it("opening balance: once per supplier, retry-safe, shows in the balance and statement", async () => {
    const ctx = await newShop("Supplier opening");
    const { id } = await createSupplier(ctx, supplier("Opening Traders"));
    const key = randomUUID();
    await recordSupplierOpeningBalance(ctx, { idempotencyKey: key, supplierId: id, amountPaise: 1_250_000, note: "Old dues" });
    await recordSupplierOpeningBalance(ctx, { idempotencyKey: key, supplierId: id, amountPaise: 1_250_000, note: "Old dues" });
    expect(await codeOf(recordSupplierOpeningBalance(ctx, { idempotencyKey: randomUUID(), supplierId: id, amountPaise: 500 }))).toBe("OPENING_ALREADY_SET");
    expect(await codeOf(recordSupplierOpeningBalance(ctx, { idempotencyKey: randomUUID(), supplierId: id, amountPaise: 0 }))).toBe("INVALID:amountPaise");
    expect(await codeOf(recordSupplierOpeningBalance(ctx, { idempotencyKey: randomUUID(), supplierId: id, amountPaise: 1.5 }))).toBe("INVALID:amountPaise");
    const statement = await getSupplierStatement(ctx, { supplierId: id });
    expect(statement.supplier.balancePaise).toBe(1_250_000);
    expect(statement.entries).toMatchObject([{ entryType: "opening", amountPaise: 1_250_000, note: "Old dues" }]);

    // An advance paid before starting is a negative opening balance.
    const other = await createSupplier(ctx, supplier("Advance Traders"));
    await recordSupplierOpeningBalance(ctx, { idempotencyKey: randomUUID(), supplierId: other.id, amountPaise: -20_000 });
    expect((await listSuppliers(ctx)).find((s) => s.id === other.id)?.balancePaise).toBe(-20_000);
  });

  it("ledger rows cannot be changed or deleted", async () => {
    const ctx = await newShop("Supplier ledger");
    const { id } = await createSupplier(ctx, supplier("Ledger Traders"));
    await recordSupplierOpeningBalance(ctx, { idempotencyKey: randomUUID(), supplierId: id, amountPaise: 100 });
    await expect(withTenant(ctx, (tx) => tx.update(partyLedgerEntries).set({ amountPaise: 1 }))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.delete(partyLedgerEntries))).rejects.toThrow();
    expect((await getSupplierStatement(ctx, { supplierId: id })).supplier.balancePaise).toBe(100);
  });
});

describe("who may manage suppliers", () => {
  it("a cashier may not see or add suppliers; an accountant may see but not add", async () => {
    const owner = await newShop("Supplier roles");
    await createSupplier(owner, supplier("Role Traders"));
    const cashier = await memberWithRole(owner, "Cashier");
    expect(await codeOf(listSuppliers(cashier))).toBe("FORBIDDEN");
    expect(await codeOf(createSupplier(cashier, supplier("Cashier Traders")))).toBe("FORBIDDEN");
    const accountant = await memberWithRole(owner, "Accountant");
    expect((await listSuppliers(accountant)).map((s) => s.name)).toEqual(["Role Traders"]);
    expect(await codeOf(createSupplier(accountant, supplier("Accountant Traders")))).toBe("FORBIDDEN");
  });
});

describe("another business", () => {
  it("cannot see, edit, archive or book against another business's supplier", async () => {
    const a = await newShop("Supplier A");
    const b = await newShop("Supplier B");
    const { id } = await createSupplier(b, supplier("Private Traders"));
    expect(await listSuppliers(a, { includeArchived: true })).toEqual([]);
    expect(await codeOf(updateSupplier(a, { id, version: 1, ...supplier("Hacked") }))).toBe("NOT_FOUND");
    expect(await codeOf(setSupplierArchived(a, { id, archived: true }))).toBe("NOT_FOUND");
    expect(await codeOf(getSupplierStatement(a, { supplierId: id }))).toBe("NOT_FOUND");
    expect(await codeOf(recordSupplierOpeningBalance(a, { idempotencyKey: randomUUID(), supplierId: id, amountPaise: 100 }))).toBe("NOT_FOUND");
    expect(await listSuppliers(b)).toMatchObject([{ name: "Private Traders", active: true, balancePaise: 0 }]);
    // Same name is fine in another business.
    expect(await codeOf(createSupplier(a, supplier("Private Traders")))).toBe("ok");
  });
});
