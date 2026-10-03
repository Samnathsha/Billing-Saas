import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  auditLogs,
  branches,
  brands,
  categories,
  devices,
  invitations,
  memberships,
  products,
  productVariants,
  rolePermissions,
  roles,
  settings,
  subscriptions,
  syncOperations,
  tenants,
  units,
} from "@/db/schema";
import { createTenantContext, withTenant, type TenantContext } from "@/db/with-tenant";

export interface TestBusiness {
  ctx: TenantContext;
  branchId: string;
}

// A business with one row in EVERY table that has a tenant_id, keyed by
// table name, so isolation tests can attack each table.
export interface FullTestBusiness extends TestBusiness {
  rowIds: Record<string, string>;
}

export function authServiceUrl(): string {
  const url = process.env.AUTH_DATABASE_URL_TEST;
  if (url === undefined || url === "") throw new Error("AUTH_DATABASE_URL_TEST must be set for database tests");
  return url;
}

// Users are created only by the login library, through auth_service
// (ADR 0003), so tests create them the same way.
export async function createTestUser(userId: string, displayName: string): Promise<void> {
  const client = new pg.Client({ connectionString: authServiceUrl() });
  await client.connect();
  try {
    await client.query("INSERT INTO users (id, email, display_name, email_verified) VALUES ($1, $2, $3, true)", [
      userId,
      `${userId}@test.invalid`,
      displayName,
    ]);
  } finally {
    await client.end();
  }
}

// Creates a new business (with its owner user and one branch) through the
// app's own role and withTenant, exactly as the app will. Random ids, so
// test runs never depend on each other.
export async function createTestBusiness(name: string): Promise<TestBusiness> {
  const ctx = createTenantContext({ tenantId: randomUUID(), userId: randomUUID() });
  const branchId = randomUUID();
  await createTestUser(ctx.userId, name);
  await withTenant(ctx, async (tx) => {
    await tx.insert(tenants).values({ id: ctx.tenantId, name, template: "clothing" });
    await tx.insert(branches).values({ id: branchId, tenantId: ctx.tenantId, name: `${name} main` });
  });
  return { ctx, branchId };
}

export async function createFullTestBusiness(name: string): Promise<FullTestBusiness> {
  const { ctx, branchId } = await createTestBusiness(name);
  const tenantId = ctx.tenantId;
  const rowIds: Record<string, string> = {
    branches: branchId,
    devices: randomUUID(),
    settings: randomUUID(),
    roles: randomUUID(),
    role_permissions: randomUUID(),
    memberships: randomUUID(),
    audit_logs: randomUUID(),
    sync_operations: randomUUID(),
    subscriptions: randomUUID(),
    invitations: randomUUID(),
    categories: randomUUID(),
    brands: randomUUID(),
    units: randomUUID(),
    products: randomUUID(),
    product_variants: randomUUID(),
  };
  const id = (table: string): string => {
    const value = rowIds[table];
    if (value === undefined) throw new Error(`no fixture id for ${table}`);
    return value;
  };

  await withTenant(ctx, async (tx) => {
    await tx.insert(devices).values({ id: id("devices"), tenantId, branchId, name: "Till 1" });
    await tx.insert(settings).values({ id: id("settings"), tenantId });
    await tx.insert(subscriptions).values({ id: id("subscriptions"), tenantId, planCode: "pilot" });
    await tx.insert(roles).values({ id: id("roles"), tenantId, name: "Owner", isSystem: true });
    await tx
      .insert(rolePermissions)
      .values({ id: id("role_permissions"), tenantId, roleId: id("roles"), permissionCode: "sales.create" });
    await tx
      .insert(memberships)
      .values({ id: id("memberships"), tenantId, userId: ctx.userId, roleId: id("roles") });
    await tx.insert(categories).values({ id: id("categories"), tenantId, name: `${name} category` });
    await tx.insert(brands).values({ id: id("brands"), tenantId, name: `${name} brand` });
    await tx.insert(units).values({ id: id("units"), tenantId, name: "Piece", code: "pcs" });
    await tx.insert(products).values({
      id: id("products"),
      tenantId,
      name: `${name} shirt`,
      unitId: id("units"),
      taxCategory: "test_5",
    });
    await tx.insert(productVariants).values({
      id: id("product_variants"),
      tenantId,
      productId: id("products"),
      sku: `SKU-${tenantId.slice(0, 8)}`,
      sellingPricePaise: 49_900,
      costPricePaise: 30_000,
    });
    await tx.insert(invitations).values({
      id: id("invitations"),
      tenantId,
      email: `invitee-${tenantId}@test.invalid`,
      roleId: id("roles"),
      tokenHash: "0".repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000),
      invitedBy: ctx.userId,
    });
    await tx.insert(auditLogs).values({
      id: id("audit_logs"),
      tenantId,
      actorUserId: ctx.userId,
      deviceId: id("devices"),
      action: "test.created",
      after: { secret: `${name} private data` },
    });
    await tx.insert(syncOperations).values({
      id: id("sync_operations"),
      tenantId,
      deviceId: id("devices"),
      clientOpId: randomUUID(),
      operation: "sale.create",
      status: "applied",
    });
  });
  return { ctx, branchId, rowIds };
}
