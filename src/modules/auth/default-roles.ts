// The roles every new business starts with, and what each may do: blueprint
// table 5.3. Businesses may adjust roles later; these are only the defaults.
// Permission codes must exist in the `permissions` table (migration 0001).

export const PERMISSIONS = [
  "sales.create",
  "invoices.void",
  "discounts.above_limit",
  "prices.change",
  "stock.adjust",
  "purchases.create",
  "costs.view",
  "reports.view",
  "users.manage",
  "settings.manage",
  "business.delete",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const OWNER_ROLE = "Owner";

export const DEFAULT_ROLES: Readonly<Record<string, readonly Permission[]>> = {
  [OWNER_ROLE]: PERMISSIONS,
  Admin: PERMISSIONS.filter((p) => p !== "business.delete"),
  Manager: [
    "sales.create",
    "invoices.void",
    "discounts.above_limit",
    "prices.change",
    "stock.adjust",
    "purchases.create",
    "costs.view",
    "reports.view",
  ],
  Cashier: ["sales.create"],
  Accountant: ["costs.view", "reports.view"],
};
