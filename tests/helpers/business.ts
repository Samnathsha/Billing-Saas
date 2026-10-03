import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  auditLogs,
  barcodes,
  branches,
  brands,
  categories,
  customers,
  devices,
  files,
  idempotencyKeys,
  invitations,
  invoiceSequences,
  memberships,
  partyLedgerEntries,
  products,
  productVariants,
  purchaseItems,
  purchases,
  rolePermissions,
  roles,
  serialNumbers,
  settings,
  stockBalances,
  stockMovements,
  subscriptions,
  supplierPayments,
  suppliers,
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
    barcodes: randomUUID(),
    serial_numbers: randomUUID(),
    files: randomUUID(),
    stock_movements: randomUUID(),
    stock_balances: randomUUID(),
    idempotency_keys: randomUUID(),
    suppliers: randomUUID(),
    party_ledger_entries: randomUUID(),
    purchases: randomUUID(),
    purchase_items: randomUUID(),
    supplier_payments: randomUUID(),
    customers: randomUUID(),
    invoice_sequences: randomUUID(),
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
    await tx.insert(barcodes).values({ id: id("barcodes"), tenantId, variantId: id("product_variants"), code: "8901234567890" });
    await tx.insert(serialNumbers).values({ id: id("serial_numbers"), tenantId, variantId: id("product_variants"), serial: "356938035643809", branchId });
    await tx.insert(files).values({
      id: id("files"),
      tenantId,
      purpose: "product_image",
      productId: id("products"),
      storageKey: `${tenantId}/${id("files")}.webp`,
      contentType: "image/webp",
      sizeBytes: 100,
      width: 10,
      height: 10,
      sha256: "0".repeat(64),
    });
    await tx.insert(stockBalances).values({ id: id("stock_balances"), tenantId, variantId: id("product_variants"), branchId, quantity: "5", averageCostPaise: "300" });
    await tx.insert(stockMovements).values({
      id: id("stock_movements"),
      tenantId,
      branchId,
      variantId: id("product_variants"),
      movementType: "OPENING_STOCK",
      quantity: "5",
      unitCostPaise: "300",
      sourceType: "opening_stock",
      sourceId: randomUUID(),
      sourceLineId: randomUUID(),
      createdBy: ctx.userId,
    });
    await tx.insert(idempotencyKeys).values({ id: id("idempotency_keys"), tenantId, key: randomUUID(), operation: "stock.opening", result: { ok: true } });
    await tx.insert(suppliers).values({ id: id("suppliers"), tenantId, name: `${name} supplier`, createdBy: ctx.userId });
    await tx.insert(purchases).values({
      id: id("purchases"),
      tenantId,
      supplierId: id("suppliers"),
      branchId,
      supplierInvoiceNumber: "B-1",
      invoiceDate: "2026-04-01",
      subtotalPaise: 1500,
      taxPaise: 75,
      totalPaise: 1575,
      costBasis: "excludes_tax",
      createdBy: ctx.userId,
    });
    await tx.insert(purchaseItems).values({
      id: id("purchase_items"),
      tenantId,
      purchaseId: id("purchases"),
      lineNumber: 1,
      variantId: id("product_variants"),
      quantity: "5",
      unitPricePaise: 300,
      taxRate: "5",
      lineSubtotalPaise: 1500,
      lineTaxPaise: 75,
      lineTotalPaise: 1575,
      unitCostPaise: "300",
    });
    await tx.insert(partyLedgerEntries).values({
      id: id("party_ledger_entries"),
      tenantId,
      supplierId: id("suppliers"),
      entryType: "purchase",
      amountPaise: 1575,
      sourceType: "purchase",
      sourceId: id("purchases"),
      createdBy: ctx.userId,
    });
    await tx.insert(customers).values({ id: id("customers"), tenantId, name: `${name} customer`, phone: "98400 55555", creditLimitPaise: 100_000, createdBy: ctx.userId });
    await tx.insert(invoiceSequences).values({ id: id("invoice_sequences"), tenantId, series: "invoice", prefix: "INV", financialYear: "26-27", lastNumber: 7 });
    await tx.insert(supplierPayments).values({
      id: id("supplier_payments"),
      tenantId,
      supplierId: id("suppliers"),
      purchaseId: id("purchases"),
      amountPaise: 1000,
      method: "cash",
      paidOn: "2026-04-01",
      createdBy: ctx.userId,
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
