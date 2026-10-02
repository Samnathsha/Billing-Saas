import { randomUUID } from "node:crypto";
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
  users,
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

// Creates a new business (with its owner user and one branch) through the
// app's own role and withTenant, exactly as the app will. Random ids, so
// test runs never depend on each other.
export async function createTestBusiness(name: string): Promise<TestBusiness> {
  const ctx = createTenantContext({ tenantId: randomUUID(), userId: randomUUID() });
  const branchId = randomUUID();
  await withTenant(ctx, async (tx) => {
    await tx.insert(users).values({ id: ctx.userId, email: `${ctx.userId}@test.invalid`, displayName: name });
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
