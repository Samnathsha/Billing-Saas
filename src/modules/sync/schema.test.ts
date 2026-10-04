import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SYNC_FLAG_CODES } from "./schema";

// The flag codes are listed twice: in TypeScript and in the database check
// (migration 0037). They must stay the same list.
describe("sync flag codes", () => {
  it("match the database check", () => {
    const migration = readFileSync(join(process.cwd(), "drizzle", "0037_offline_tills.sql"), "utf8");
    const check = /"sync_flags_code_valid" CHECK \("sync_flags"\."code" in \(([^)]*)\)\)/.exec(migration)?.[1] ?? "";
    expect(check.split(",").map((c) => c.trim().replace(/'/g, ""))).toEqual([...SYNC_FLAG_CODES]);
  });
});
