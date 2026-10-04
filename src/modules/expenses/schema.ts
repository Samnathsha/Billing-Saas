import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, mutableRowColumns, tenantIdColumn } from "@/db/columns";
import { branches, tenants } from "@/modules/tenants/schema";

// Shop expenses (business rules 16): rent, salaries, electricity, tea...
// Recorded by "Record expenses" (Owner, Admin, Manager); the Accountant
// can view them. An expense is never edited: a mistake is voided with a
// reason (database trigger) and entered again.

export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...mutableRowColumns(),
  },
  (t) => [
    unique("expense_categories_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("expense_categories_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
    check("expense_categories_name_length", sql`char_length(${t.name}) between 1 and 60`),
  ],
);

export const expenses = pgTable(
  "expenses",
  {
    id: idColumn(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").notNull(),
    categoryId: uuid("category_id").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    // 'cash' | 'upi' | 'card' | 'bank'
    method: text("method").notNull(),
    paidOn: date("paid_on").notNull(),
    description: text("description").notNull(),
    reference: text("reference"),
    // 'posted' | 'voided'
    status: text("status").notNull().default("posted"),
    voidReason: text("void_reason"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique("expenses_tenant_id_id_key").on(t.tenantId, t.id),
    index("expenses_tenant_paid_on_idx").on(t.tenantId, t.paidOn),
    foreignKey({ name: "expenses_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }).onDelete("restrict"),
    foreignKey({ name: "expenses_category_fk", columns: [t.tenantId, t.categoryId], foreignColumns: [expenseCategories.tenantId, expenseCategories.id] }).onDelete("restrict"),
    check("expenses_amount", sql`${t.amountPaise} > 0 AND ${t.amountPaise} <= 100000000000`),
    check("expenses_method", sql`${t.method} in ('cash', 'upi', 'card', 'bank')`),
    check("expenses_status", sql`${t.status} in ('posted', 'voided')`),
    check("expenses_void_fields", sql`(${t.status} = 'voided') = (${t.voidReason} IS NOT NULL AND ${t.voidedAt} IS NOT NULL AND ${t.voidedBy} IS NOT NULL)`),
    check("expenses_text_lengths", sql`char_length(${t.description}) between 1 and 200 AND char_length(${t.reference}) <= 60 AND char_length(${t.voidReason}) <= 500`),
  ],
);
