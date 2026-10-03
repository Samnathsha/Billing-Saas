import { sql, type SQL } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";

// Tax rates as data (business rule 4): global, read-only for the app, only
// clearly labelled TEST rates until the accountant supplies real ones.

afterAll(async () => {
  await getDb().$client.end();
});

const rows = async (query: SQL) => (await getDb().execute(query)).rows;

describe("what the app can read", () => {
  it("only the two TEST categories and rates exist, clearly labelled", async () => {
    expect(await rows(sql`SELECT code, label, is_test FROM tax_categories ORDER BY code`)).toEqual([
      { code: "test_18", label: "TEST 18%", is_test: true },
      { code: "test_5", label: "TEST 5%", is_test: true },
    ]);
    expect(await rows(sql`SELECT tax_category, label, rate, is_test FROM tax_rates ORDER BY rate`)).toEqual([
      { tax_category: "test_5", label: "TEST 5%", rate: "5.0000", is_test: true },
      { tax_category: "test_18", label: "TEST 18%", rate: "18.0000", is_test: true },
    ]);
  });

  it("no two rates of a category overlap in dates and price per piece", async () => {
    const overlaps = await rows(sql`
      SELECT a.id FROM tax_rates a JOIN tax_rates b
        ON a.id < b.id AND a.country_code = b.country_code AND a.tax_category = b.tax_category
       WHERE daterange(a.effective_from, a.effective_to) && daterange(b.effective_from, b.effective_to)
         AND int8range(a.price_min_paise, a.price_max_paise) && int8range(b.price_min_paise, b.price_max_paise)`);
    expect(overlaps).toEqual([]);
  });
});

describe("the app cannot change tax rates", () => {
  it.each([
    ["raise a rate", sql`UPDATE tax_rates SET rate = 0`],
    ["add a rate", sql`INSERT INTO tax_rates (tax_category, label, rate, effective_from) VALUES ('test_5', 'Mine', 0, '2026-01-01')`],
    ["delete rates", sql`DELETE FROM tax_rates`],
    ["add a category", sql`INSERT INTO tax_categories (code, label) VALUES ('mine', 'Mine')`],
    ["rename a category", sql`UPDATE tax_categories SET label = 'Zero'`],
  ])("%s: refused", async (_name, statement) => {
    const error: unknown = await getDb().execute(statement).catch((e: unknown) => e);
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
    expect(cause).toMatch(/permission denied/);
  });
});
