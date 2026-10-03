import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getAuthDb } from "@/db/auth-client";
import { getDb } from "@/db/client";
import { auditLogs, memberships, roles } from "@/db/schema";
import { withTenant, type TenantContext } from "@/db/with-tenant";
import { createBusiness, getRequestContext, PermissionDeniedError } from "@/modules/auth";
import {
  CatalogError,
  createBrand,
  createCategory,
  createUnit,
  getCatalogLists,
  renameListItem,
  setListItemArchived,
} from "@/modules/catalog";
import { registerVerifiedUser } from "../helpers/auth";

// Categories, brands and units: starting units, names, subcategories,
// archive/restore, audit, "Manage products", other businesses.

afterAll(async () => {
  await getAuthDb().$client.end();
  await getDb().$client.end();
});

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

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof CatalogError || error instanceof PermissionDeniedError) return error.code;
    if (error instanceof ZodError) return "INVALID_INPUT";
    throw error;
  }
}

async function auditActions(ctx: TenantContext): Promise<string[]> {
  const rows = await withTenant(ctx, (tx) =>
    tx.select({ action: auditLogs.action }).from(auditLogs).orderBy(asc(auditLogs.occurredAt), asc(auditLogs.id)),
  );
  return rows.map((r) => r.action).filter((a) => a.startsWith("catalog."));
}

describe("a new business", () => {
  it("starts with Piece (whole) and Metre (fractions), and no categories or brands", async () => {
    const ctx = await newShop("Lists New");
    const lists = await getCatalogLists(ctx);
    expect(lists.units.map(({ name, code, allowsFraction, active }) => ({ name, code, allowsFraction, active }))).toEqual([
      { name: "Metre", code: "m", allowsFraction: true, active: true },
      { name: "Piece", code: "pcs", allowsFraction: false, active: true },
    ]);
    expect(lists.categories).toEqual([]);
    expect(lists.brands).toEqual([]);
  });
});

describe("categories", () => {
  it("main and sub categories, one level deep; audited", async () => {
    const ctx = await newShop("Cats");
    const men = await createCategory(ctx, { name: " Men ", parentId: "" });
    const shirts = await createCategory(ctx, { name: "Shirts", parentId: men.id });
    expect(await codeOf(createCategory(ctx, { name: "Formal", parentId: shirts.id }))).toBe("PARENT_INVALID");
    const lists = await getCatalogLists(ctx);
    expect(lists.categories.map(({ name, parentId }) => ({ name, parentId }))).toEqual([
      { name: "Men", parentId: null },
      { name: "Shirts", parentId: men.id },
    ]);
    expect(await auditActions(ctx)).toEqual(["catalog.category_created", "catalog.category_created"]);
  });

  it("an archived or unknown parent is refused", async () => {
    const ctx = await newShop("Cats Parent");
    const old = await createCategory(ctx, { name: "Old", parentId: null });
    await setListItemArchived(ctx, { kind: "category", id: old.id, archived: true });
    expect(await codeOf(createCategory(ctx, { name: "Child", parentId: old.id }))).toBe("PARENT_INVALID");
    expect(await codeOf(createCategory(ctx, { name: "Child", parentId: "00000000-0000-4000-8000-000000000000" }))).toBe("PARENT_INVALID");
  });
});

describe("names", () => {
  it.each([
    ["category", (ctx: TenantContext, n: string) => createCategory(ctx, { name: n, parentId: null })],
    ["brand", (ctx: TenantContext, n: string) => createBrand(ctx, { name: n })],
  ] as const)("%s names are unique ignoring capitals, also against archived ones", async (kind, create) => {
    const ctx = await newShop(`Names ${kind}`);
    const first = await create(ctx, "Raymond");
    expect(await codeOf(create(ctx, "RAYMOND"))).toBe("NAME_TAKEN");
    await setListItemArchived(ctx, { kind, id: first.id, archived: true });
    expect(await codeOf(create(ctx, "raymond"))).toBe("NAME_TAKEN");
  });

  it("units: name and code unique ignoring capitals; codes are short", async () => {
    const ctx = await newShop("Units");
    expect(await codeOf(createUnit(ctx, { name: "Dozen", code: "dz", allowsFraction: false }))).toBe("ok");
    expect(await codeOf(createUnit(ctx, { name: "PIECE", code: "pc", allowsFraction: false }))).toBe("NAME_TAKEN");
    expect(await codeOf(createUnit(ctx, { name: "Pieces", code: "PCS", allowsFraction: false }))).toBe("CODE_TAKEN");
    expect(await codeOf(createUnit(ctx, { name: "Long", code: "a very long code", allowsFraction: false }))).toBe("INVALID_INPUT");
  });

  it("rename: same name changes nothing; another item's name is refused; audited", async () => {
    const ctx = await newShop("Rename Lists");
    const a = await createBrand(ctx, { name: "Alpha" });
    await createBrand(ctx, { name: "Beta" });
    await renameListItem(ctx, { kind: "brand", id: a.id, name: "Alpha" });
    expect(await codeOf(renameListItem(ctx, { kind: "brand", id: a.id, name: "beta" }))).toBe("NAME_TAKEN");
    await renameListItem(ctx, { kind: "brand", id: a.id, name: "Gamma" });
    expect((await getCatalogLists(ctx)).brands.map((b) => b.name)).toEqual(["Beta", "Gamma"]);
    expect(await auditActions(ctx)).toEqual(["catalog.brand_created", "catalog.brand_created", "catalog.brand_renamed"]);
  });
});

describe("archive and restore", () => {
  it("archived items stay listed as inactive and can be restored", async () => {
    const ctx = await newShop("Archive");
    const pcs = (await getCatalogLists(ctx)).units.find((u) => u.code === "pcs")?.id ?? "";
    await setListItemArchived(ctx, { kind: "unit", id: pcs, archived: true });
    expect((await getCatalogLists(ctx)).units.find((u) => u.id === pcs)?.active).toBe(false);
    expect(await codeOf(setListItemArchived(ctx, { kind: "unit", id: pcs, archived: true }))).toBe("ALREADY_ARCHIVED");
    await setListItemArchived(ctx, { kind: "unit", id: pcs, archived: false });
    expect(await codeOf(setListItemArchived(ctx, { kind: "unit", id: pcs, archived: false }))).toBe("NOT_ARCHIVED");
    expect(await auditActions(ctx)).toEqual(["catalog.unit_archived", "catalog.unit_restored"]);
  });

  it("nothing can be deleted, even directly in the database", async () => {
    const ctx = await newShop("No Delete");
    const error: unknown = await withTenant(ctx, (tx) => tx.execute("DELETE FROM units")).catch((e: unknown) => e);
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
    expect(cause).toMatch(/permission denied/);
  });
});

describe("who may manage the lists", () => {
  it.each(["Cashier", "Accountant"])("%s may not", async (role) => {
    const owner = await newShop(`Lists ${role}`);
    const user = await registerVerifiedUser(`Lists ${role}`);
    await withTenant(owner, async (tx) => {
      const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, role));
      await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
    });
    const ctx = await memberCtx(user.headers);
    expect(await codeOf(getCatalogLists(ctx))).toBe("FORBIDDEN");
    expect(await codeOf(createBrand(ctx, { name: "Sneaky" }))).toBe("FORBIDDEN");
    expect((await getCatalogLists(owner)).brands).toEqual([]);
  });

  it("a Manager may", async () => {
    const owner = await newShop("Lists Manager");
    const user = await registerVerifiedUser("Lists Manager");
    await withTenant(owner, async (tx) => {
      const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, "Manager"));
      await tx.insert(memberships).values({ tenantId: owner.tenantId, userId: user.userId, roleId: r?.id ?? "" });
    });
    expect(await codeOf(createBrand(await memberCtx(user.headers), { name: "Manager Brand" }))).toBe("ok");
  });
});

describe("another business", () => {
  it("cannot rename, archive or use another business's items", async () => {
    const a = await newShop("Lists A");
    const b = await newShop("Lists B");
    const bCat = await createCategory(b, { name: "B Only", parentId: null });
    expect(await codeOf(renameListItem(a, { kind: "category", id: bCat.id, name: "Hacked" }))).toBe("NOT_FOUND");
    expect(await codeOf(setListItemArchived(a, { kind: "category", id: bCat.id, archived: true }))).toBe("NOT_FOUND");
    expect(await codeOf(createCategory(a, { name: "Child", parentId: bCat.id }))).toBe("PARENT_INVALID");
    expect((await getCatalogLists(b)).categories).toEqual([{ id: bCat.id, name: "B Only", parentId: null, active: true }]);
  });
});
