import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auditLogs, memberships, roles, settings } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { financialYearStart } from "@/modules/sales";
import { gstinCheckChar } from "@/modules/tax/gst";
import { getBusinessProfile, SettingsError, updateBusinessProfile } from "@/modules/tenants";
import { registerVerifiedUser } from "../helpers/auth";

// Business profile and GST settings: permissions, validation, audit, the
// "changed by someone else" guard and the database's own checks.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

const TN_GSTIN = (() => {
  const first14 = "33ABCDE1234F1Z";
  return first14 + gstinCheckChar(first14);
})();

async function memberCtx(headers: Headers): Promise<TenantContext> {
  const result = await getRequestContext(headers);
  if (result.kind !== "member") throw new Error(`expected a member, got ${result.kind}`);
  return result.ctx;
}

async function newShop(label: string): Promise<TenantContext> {
  const owner = await registerVerifiedUser(`${label} Owner`);
  await createBusiness(owner.headers, { businessName: `${label} Shop`, template: "clothing" });
  return memberCtx(owner.headers);
}

async function staff(ownerCtx: TenantContext, role: string): Promise<TenantContext> {
  const user = await registerVerifiedUser(`Profile ${role}`);
  await withTenant(ownerCtx, async (tx) => {
    const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
    await tx.insert(memberships).values({ tenantId: ownerCtx.tenantId, userId: user.userId, roleId: r?.id ?? "" });
  });
  return memberCtx(user.headers);
}

function fullProfile(version: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    businessName: "Sharma Textiles",
    addressLine1: "12 Market Road",
    addressLine2: "",
    city: "Chennai",
    stateCode: "33",
    pincode: "600001",
    phone: "+91 98400 00000",
    contactEmail: "shop@example.com",
    gstRegistration: "registered",
    gstin: TN_GSTIN,
    pricesIncludeTax: true,
    invoicePrefix: "INV",
    creditNotePrefix: "CN",
    version,
    ...overrides,
  };
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof SettingsError || error instanceof PermissionDeniedError) return error.code;
    if (error instanceof ZodError) return `INVALID:${error.issues.map((i) => i.path.join(".")).join(",")}`;
    throw error;
  }
}

async function auditRows(ctx: TenantContext) {
  return withTenant(ctx, (tx) =>
    tx.select({ action: auditLogs.action, before: auditLogs.before, after: auditLogs.after, role: auditLogs.actorRole }).from(auditLogs).where(eq(auditLogs.action, "settings.profile_updated")).orderBy(asc(auditLogs.occurredAt), asc(auditLogs.id)),
  );
}

describe("reading the profile", () => {
  it("a new business starts with its name and nothing else set", async () => {
    const ctx = await newShop("Fresh");
    const profile = await getBusinessProfile(ctx);
    expect(profile).toMatchObject({
      businessName: "Fresh Shop",
      template: "clothing",
      stateCode: null,
      gstRegistration: null,
      gstin: null,
      pricesIncludeTax: true,
      version: 1,
    });
  });
});

describe("saving the profile", () => {
  let ctx: TenantContext;
  beforeAll(async () => {
    ctx = await newShop("Save");
  });

  it("saves everything, cleans up the input, and audits only what changed", async () => {
    const result = await updateBusinessProfile(ctx, fullProfile(1, { gstin: ` ${TN_GSTIN.toLowerCase().slice(0, 7)} ${TN_GSTIN.toLowerCase().slice(7)} ` }));
    expect(result).toEqual({ changed: true, version: 2 });
    const profile = await getBusinessProfile(ctx);
    expect(profile).toMatchObject({ businessName: "Sharma Textiles", stateName: "Tamil Nadu", gstin: TN_GSTIN, addressLine2: null, version: 2 });

    const rows = await auditRows(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("Owner");
    expect(rows[0]?.before).toMatchObject({ businessName: "Save Shop", gstRegistration: null, gstin: null });
    expect(rows[0]?.after).toMatchObject({ businessName: "Sharma Textiles", gstRegistration: "registered", gstin: TN_GSTIN });
    // Unchanged fields are not in the entry.
    expect(rows[0]?.after).not.toHaveProperty("pricesIncludeTax");
    expect(rows[0]?.after).not.toHaveProperty("addressLine2");
  });

  it("saving the same values changes nothing and adds no audit entry", async () => {
    expect(await updateBusinessProfile(ctx, fullProfile(2))).toEqual({ changed: false, version: 2 });
    expect(await auditRows(ctx)).toHaveLength(1);
  });

  it("a page showing an older version cannot overwrite a newer change", async () => {
    expect(await codeOf(updateBusinessProfile(ctx, fullProfile(1, { city: "Madurai" })))).toBe("CHANGED_BY_SOMEONE_ELSE");
    expect((await getBusinessProfile(ctx)).city).toBe("Chennai");
  });

  it("switching to unregistered clears the GSTIN", async () => {
    expect(await codeOf(updateBusinessProfile(ctx, fullProfile(2, { gstRegistration: "unregistered", gstin: "" })))).toBe("ok");
    expect(await getBusinessProfile(ctx)).toMatchObject({ gstRegistration: "unregistered", gstin: null, version: 3 });
  });
});

describe("validation (nothing is saved)", () => {
  let ctx: TenantContext;
  beforeAll(async () => {
    ctx = await newShop("Validate");
  });

  const wrongCheck = TN_GSTIN.slice(0, 14) + (TN_GSTIN.endsWith("A") ? "B" : "A");
  const karnataka = (() => {
    const first14 = "29ABCDE1234F1Z";
    return first14 + gstinCheckChar(first14);
  })();

  it.each([
    ["a GSTIN with a typing mistake", { gstin: wrongCheck }, "gstin"],
    ["a GSTIN that is not 15 characters", { gstin: "33ABCDE1234" }, "gstin"],
    ["registered without a GSTIN", { gstin: "" }, "gstin"],
    ["composition without a GSTIN", { gstRegistration: "composition", gstin: "" }, "gstin"],
    ["unregistered with a GSTIN", { gstRegistration: "unregistered" }, "gstin"],
    ["a GSTIN from another state", { gstin: karnataka }, "gstin"],
    ["a GSTIN without a state", { stateCode: "" }, "stateCode"],
    ["a state that does not exist", { stateCode: "99", gstRegistration: "unregistered", gstin: "" }, "stateCode"],
    ["a 5-digit PIN code", { pincode: "60001" }, "pincode"],
    ["letters in the phone number", { phone: "call me" }, "phone"],
    ["a bad email", { contactEmail: "not-an-email" }, "contactEmail"],
    ["an empty business name", { businessName: "   " }, "businessName"],
    ["no GST registration chosen", { gstRegistration: null }, "gstRegistration"],
    ["prices-include-tax as text", { pricesIncludeTax: "yes" }, "pricesIncludeTax"],
    ["an extra field such as another business id", { tenantId: "00000000-0000-4000-8000-000000000000" }, ""],
  ])("refuses %s", async (_name, overrides, path) => {
    const code = await codeOf(updateBusinessProfile(ctx, fullProfile(1, overrides)));
    expect(code).toMatch(/^INVALID:/);
    expect(code.split(":")[1]?.split(",")).toContain(path);
    expect((await getBusinessProfile(ctx)).version).toBe(1);
  });

  it("composition with a valid GSTIN of its state is accepted", async () => {
    expect(await codeOf(updateBusinessProfile(ctx, fullProfile(1, { gstRegistration: "composition" })))).toBe("ok");
  });
});

describe("bill and credit-note prefixes", () => {
  let ctx: TenantContext;
  beforeAll(async () => {
    ctx = await newShop("Prefix");
  });

  it("start as INV and CN, with the current financial year for the example", async () => {
    const profile = await getBusinessProfile(ctx);
    expect(profile).toMatchObject({ invoicePrefix: "INV", creditNotePrefix: "CN" });
    expect(profile.financialYear).toMatch(/^[0-9]{2}-[0-9]{2}$/);
    const fyStart = financialYearStart(new Date(), "Asia/Kolkata", 4);
    expect(profile.financialYear).toBe(`${String(fyStart % 100).padStart(2, "0")}-${String((fyStart + 1) % 100).padStart(2, "0")}`);
  });

  it("are cleaned up (spaces, lower case), saved and audited", async () => {
    expect(await codeOf(updateBusinessProfile(ctx, fullProfile(1, { invoicePrefix: " shp ", creditNotePrefix: "cr1" })))).toBe("ok");
    expect(await getBusinessProfile(ctx)).toMatchObject({ invoicePrefix: "SHP", creditNotePrefix: "CR1" });
    const last = (await auditRows(ctx)).at(-1);
    expect(last?.before).toMatchObject({ invoicePrefix: "INV", creditNotePrefix: "CN" });
    expect(last?.after).toMatchObject({ invoicePrefix: "SHP", creditNotePrefix: "CR1" });
  });

  it.each([
    ["5 characters", { invoicePrefix: "SHOPS" }, "invoicePrefix"],
    ["a slash", { invoicePrefix: "IN/V" }, "invoicePrefix"],
    ["a hyphen", { creditNotePrefix: "C-N" }, "creditNotePrefix"],
    ["empty", { invoicePrefix: "  " }, "invoicePrefix"],
    ["the same for bills and credit notes", { invoicePrefix: "INV", creditNotePrefix: "inv" }, "creditNotePrefix"],
  ])("refuse %s", async (_name, overrides, path) => {
    const before = await getBusinessProfile(ctx);
    const code = await codeOf(updateBusinessProfile(ctx, fullProfile(before.version, overrides)));
    expect(code.split(":")[1]?.split(",")).toContain(path);
    expect((await getBusinessProfile(ctx)).version).toBe(before.version);
  });
});

describe("who may see and change settings", () => {
  let ownerCtx: TenantContext;
  beforeAll(async () => {
    ownerCtx = await newShop("Roles");
  });

  it("Admin may", async () => {
    const admin = await staff(ownerCtx, "Admin");
    expect(await codeOf(getBusinessProfile(admin))).toBe("ok");
    expect(await codeOf(updateBusinessProfile(admin, fullProfile(1)))).toBe("ok");
    expect((await auditRows(ownerCtx)).at(-1)?.role).toBe("Admin");
  });

  it.each(["Manager", "Cashier", "Accountant"])("%s may not read or change them", async (role) => {
    const ctx = await staff(ownerCtx, role);
    const before = await getBusinessProfile(ownerCtx);
    expect(await codeOf(getBusinessProfile(ctx))).toBe("FORBIDDEN");
    expect(await codeOf(updateBusinessProfile(ctx, fullProfile(before.version, { city: "Hacked" })))).toBe("FORBIDDEN");
    expect((await getBusinessProfile(ownerCtx)).city).toBe(before.city);
  });
});

describe("another business", () => {
  it("each business sees and changes only its own profile", async () => {
    const a = await newShop("Iso A");
    const b = await newShop("Iso B");
    await updateBusinessProfile(a, fullProfile(1, { businessName: "Only A" }));
    expect((await getBusinessProfile(b)).businessName).toBe("Iso B Shop");
    expect((await getBusinessProfile(a)).businessName).toBe("Only A");
  });
});

describe("the database refuses bad combinations on its own", () => {
  it.each([
    ["a GSTIN without a registration", { gstin: TN_GSTIN, stateCode: "33" }],
    ["registered without a GSTIN", { gstRegistration: "registered" }],
    ["a GSTIN whose state differs", { gstRegistration: "registered", gstin: TN_GSTIN, stateCode: "29" }],
    ["a GSTIN with no state at all", { gstRegistration: "registered", gstin: TN_GSTIN }],
    ["a lower-case GSTIN", { gstRegistration: "registered", gstin: TN_GSTIN.toLowerCase(), stateCode: "33" }],
    ["an unknown registration type", { gstRegistration: "maybe" }],
    ["a 5-digit PIN code", { pincode: "60001" }],
    ["the same prefix for bills and credit notes", { invoicePrefix: "INV", creditNotePrefix: "INV" }],
    ["a lower-case prefix", { invoicePrefix: "inv" }],
    ["a 5-character prefix", { creditNotePrefix: "CREDI" }],
  ])("%s", async (_name, values) => {
    const ctx = await newShop("Constraint");
    await expect(withTenant(ctx, (tx) => tx.update(settings).set(values).where(eq(settings.tenantId, ctx.tenantId)))).rejects.toThrow();
  });
});
