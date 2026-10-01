import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

// Runs the real eslint.config.mjs against small code samples. Type-aware rules
// are switched off here only because the sample files do not exist on disk;
// every rule this file checks works without type information.
const eslint = new ESLint({
  overrideConfig: [{ ...tseslint.configs.disableTypeChecked, files: ["**/*.ts", "**/*.tsx"] }],
});

const GUARDED_RULES = ["no-restricted-imports", "no-restricted-syntax", "react/no-danger"];

async function guardedRuleHits(code: string, filePath: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath });
  return results
    .flatMap((result) => result.messages)
    .map((message) => message.ruleId ?? "fatal")
    .filter((ruleId) => ruleId === "fatal" || GUARDED_RULES.includes(ruleId));
}

const blocked: [name: string, filePath: string, code: string, rule: string][] = [
  // Module boundaries
  ["page imports module internals", "src/app/page.tsx", 'import { a } from "@/modules/sales/service";', "no-restricted-imports"],
  ["page imports the db", "src/app/page.tsx", 'import { db } from "@/db/client";', "no-restricted-imports"],
  ["page opens a connection", "src/app/api/x/route.ts", 'import { Pool } from "pg";', "no-restricted-imports"],
  ["module reaches into another module", "src/modules/sales/service.ts", 'import { r } from "@/modules/catalog/repo";', "no-restricted-imports"],
  ["service writes queries", "src/modules/sales/service.ts", 'import { eq } from "drizzle-orm";', "no-restricted-imports"],
  ["module uses the raw db client", "src/modules/sales/service.ts", 'import { db } from "@/db/client";', "no-restricted-imports"],
  ["repo opens its own connection", "src/modules/sales/repo.ts", 'import { Pool } from "pg";', "no-restricted-imports"],
  ["module imports from app", "src/modules/sales/service.ts", 'import { x } from "@/app/page";', "no-restricted-imports"],
  ["module imports UI", "src/modules/sales/service.ts", 'import { Button } from "@/components/ui/button";', "no-restricted-imports"],
  ["relative import out of the folder", "src/modules/sales/service.ts", 'import { x } from "../catalog/repo";', "no-restricted-imports"],
  ["lib imports a module", "src/lib/money.ts", 'import { x } from "@/modules/sales";', "no-restricted-imports"],
  ["db imports a module", "src/db/with-tenant.ts", 'import { x } from "@/modules/sales";', "no-restricted-imports"],
  ["db schema imports a service", "src/db/schema/index.ts", 'export * from "@/modules/sales/service";', "no-restricted-imports"],
  ["component imports module code", "src/components/pos/cart.tsx", 'import { createSale } from "@/modules/sales";', "no-restricted-imports"],
  ["schema imports another module's repo", "src/modules/auth/schema.ts", 'import { r } from "@/modules/tenants/repo";', "no-restricted-imports"],
  ["service imports another module's schema", "src/modules/sales/service.ts", 'import { t } from "@/modules/tenants/schema";', "no-restricted-imports"],

  // XSS
  ["dangerouslySetInnerHTML in JSX", "src/components/x.tsx", "export const X = (p: { h: string }) => <div dangerouslySetInnerHTML={{ __html: p.h }} />;", "no-restricted-syntax"],
  ["dangerouslySetInnerHTML in props object", "src/components/x.tsx", "export const props = { dangerouslySetInnerHTML: { __html: '' } };", "no-restricted-syntax"],
  ["innerHTML assignment", "src/components/x.tsx", "export function f(el: HTMLElement, h: string) { el.innerHTML = h; }", "no-restricted-syntax"],

  // String-built SQL
  ["SQL in a template string", "src/modules/sales/repo.ts", "export const q = (id: string) => `SELECT * FROM sales WHERE id = ${id}`;", "no-restricted-syntax"],
  ["SQL joined with +", "src/modules/sales/repo.ts", "export const q = (id: string) => 'DELETE FROM sales WHERE id = ' + id;", "no-restricted-syntax"],
  ["built string passed to query()", "src/db/client.ts", "export const f = (c: { query(s: string): void }, t: string) => c.query(`from ${t}`);", "no-restricted-syntax"],
  ["concatenation passed to execute()", "src/db/client.ts", "export const f = (c: { execute(s: string): void }, t: string) => c.execute('from ' + t);", "no-restricted-syntax"],
  ["sql.raw()", "src/modules/sales/repo.ts", 'import { sql } from "drizzle-orm";\nexport const f = (t: string) => sql.raw(t);', "no-restricted-syntax"],
];

const allowed: [name: string, filePath: string, code: string][] = [
  ["page uses a module's index", "src/app/page.tsx", 'import { a } from "@/modules/sales";\nexport default a;'],
  ["service uses another module's index and withTenant", "src/modules/sales/service.ts", 'import { b } from "@/modules/catalog";\nimport { withTenant } from "@/db/with-tenant";\nimport type { SQL } from "drizzle-orm";\nexport { b, withTenant };\nexport type { SQL };'],
  ["repo uses Drizzle with a parameterised sql tag", "src/modules/sales/repo.ts", 'import { sql } from "drizzle-orm";\nexport const q = (id: string) => sql`SELECT * FROM sales WHERE id = ${id}`;'],
  ["module imports its own files", "src/modules/sales/service.ts", 'import { r } from "./repo";\nexport { r };'],
  ["db opens the connection", "src/db/client.ts", 'import { Pool } from "pg";\nexport const pool = new Pool();'],
  ["db schema gathers module tables", "src/db/schema/index.ts", 'export * from "@/modules/sales/schema";'],
  ["schema references another module's tables", "src/modules/auth/schema.ts", 'import { tenants } from "@/modules/tenants/schema";\nexport { tenants };'],
  ["component imports a module DTO type", "src/components/pos/cart.tsx", 'import type { SaleDto } from "@/modules/sales";\nexport type { SaleDto };'],
];

describe("lint rules block forbidden code", () => {
  it.each(blocked)("%s", async (_name, filePath, code, rule) => {
    expect(await guardedRuleHits(code, filePath)).toContain(rule);
  });
});

describe("lint rules allow the intended patterns", () => {
  it.each(allowed)("%s", async (_name, filePath, code) => {
    expect(await guardedRuleHits(code, filePath)).toEqual([]);
  });
});

describe("rules cannot be switched off inside a file", () => {
  it("ignores eslint-disable comments", async () => {
    const code =
      "// eslint-disable-next-line no-restricted-syntax\n" +
      "export const X = (p: { h: string }) => <div dangerouslySetInnerHTML={{ __html: p.h }} />;";
    expect(await guardedRuleHits(code, "src/components/x.tsx")).toContain("no-restricted-syntax");
  });
});
