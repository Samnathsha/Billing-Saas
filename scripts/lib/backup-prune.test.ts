import { describe, expect, it } from "vitest";
import { backupsToDelete } from "./backup-prune";

describe("backup retention: 30 daily, 12 monthly", () => {
  it("keeps the last 30 days (today included) and deletes older days", () => {
    const keys = ["daily/2026-10-04.dump.age", "daily/2026-09-05.dump.age", "daily/2026-09-04.dump.age", "daily/2025-01-01.dump.age"];
    expect(backupsToDelete(keys, "2026-10-04")).toEqual(["daily/2026-09-04.dump.age", "daily/2025-01-01.dump.age"]);
  });

  it("keeps this month and the 11 before it", () => {
    const keys = ["monthly/2026-10.dump.age", "monthly/2025-11.dump.age", "monthly/2025-10.dump.age", "monthly/2024-12.dump.age"];
    expect(backupsToDelete(keys, "2026-10-04")).toEqual(["monthly/2025-10.dump.age", "monthly/2024-12.dump.age"]);
  });

  it("never touches anything else in the bucket", () => {
    expect(backupsToDelete(["notes.txt", "daily/2020-01-01.dump", "manual/2020-01-01.dump.age", "daily/../x.dump.age"], "2026-10-04")).toEqual([]);
  });

  it("refuses a bad day", () => {
    expect(() => backupsToDelete([], "yesterday")).toThrow();
  });
});
