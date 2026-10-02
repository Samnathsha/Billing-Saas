import { randomUUID } from "node:crypto";
import { branches, tenants, users } from "@/db/schema";
import { createTenantContext, withTenant, type TenantContext } from "@/db/with-tenant";

export interface TestBusiness {
  ctx: TenantContext;
  branchId: string;
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
