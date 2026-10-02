import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  auditLogs,
  branches,
  devices,
  memberships,
  rolePermissions,
  roles,
  settings,
  syncOperations,
  tenants,
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
  };
  const id = (table: string): string => {
    const value = rowIds[table];
    if (value === undefined) throw new Error(`no fixture id for ${table}`);
    return value;
  };

  await withTenant(ctx, async (tx) => {
    await tx.insert(devices).values({ id: id("devices"), tenantId, branchId, name: "Till 1" });
    await tx.insert(settings).values({ id: id("settings"), tenantId });
    await tx.insert(roles).values({ id: id("roles"), tenantId, name: "Owner", isSystem: true });
    await tx
      .insert(rolePermissions)
      .values({ id: id("role_permissions"), tenantId, roleId: id("roles"), permissionCode: "sales.create" });
    await tx
      .insert(memberships)
      .values({ id: id("memberships"), tenantId, userId: ctx.userId, roleId: id("roles") });
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
