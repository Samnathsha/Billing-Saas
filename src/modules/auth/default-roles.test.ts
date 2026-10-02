import { describe, expect, it } from "vitest";
import { DEFAULT_ROLES, OWNER_ROLE, PERMISSIONS } from "./default-roles";

// Blueprint table 5.3, restated row by row: Owner, Admin, Manager, Cashier,
// Accountant. If the business changes the matrix, change it in both places.
const BLUEPRINT_5_3: Record<string, [string, boolean, boolean, boolean, boolean, boolean]> = {
  "Create sale": ["sales.create", true, true, true, true, false],
  "Void a posted invoice": ["invoices.void", true, true, true, false, false],
  "Give discount above a set limit": ["discounts.above_limit", true, true, true, false, false],
  "Change a selling price": ["prices.change", true, true, true, false, false],
  "Stock adjustment": ["stock.adjust", true, true, true, false, false],
  "Create purchase": ["purchases.create", true, true, true, false, false],
  "View cost price and profit": ["costs.view", true, true, true, false, true],
  "Reports and exports": ["reports.view", true, true, true, false, true],
  "Manage users and roles": ["users.manage", true, true, false, false, false],
  "Business and tax settings": ["settings.manage", true, true, false, false, false],
  "Delete business or transfer ownership": ["business.delete", true, false, false, false, false],
};
const COLUMNS = ["Owner", "Admin", "Manager", "Cashier", "Accountant"] as const;

describe("default roles match blueprint table 5.3", () => {
  it("has exactly the five default roles", () => {
    expect(Object.keys(DEFAULT_ROLES).sort()).toEqual([...COLUMNS].sort());
    expect(OWNER_ROLE).toBe("Owner");
  });

  it("covers every permission in the table, and no others", () => {
    expect([...PERMISSIONS].sort()).toEqual(Object.values(BLUEPRINT_5_3).map(([code]) => code).sort());
  });

  it.each(Object.entries(BLUEPRINT_5_3))("%s", (_action, [code, ...allowed]) => {
    COLUMNS.forEach((role, i) => {
      expect(DEFAULT_ROLES[role]?.includes(code as never), `${role} / ${code}`).toBe(allowed[i]);
    });
  });
});
