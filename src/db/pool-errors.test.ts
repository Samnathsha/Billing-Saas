import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardPool } from "./pool-errors";

describe("guardPool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a dropped idle connection neither crashes the app nor prints its password", async () => {
    const pool = guardPool(new Pool({ connectionString: "postgresql://someone:not-a-real-secret-123@localhost:1/x" }), "app");
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    // What pg-pool does when an idle client fails: the client rides along.
    const error = Object.assign(new Error("read EHOSTUNREACH"), { code: "EHOSTUNREACH", client: { password: "not-a-real-secret-123" } });
    expect(() => pool.emit("error", error)).not.toThrow();
    expect(logged).toEqual(["database connection lost (app, code EHOSTUNREACH); the next query reconnects"]);
    expect(logged.join("")).not.toContain("not-a-real-secret-123");
    await pool.end();
  });

  it("without the guard, the same event would crash (why it exists)", async () => {
    const pool = new Pool({ connectionString: "postgresql://someone@localhost:1/x" });
    expect(() => pool.emit("error", new Error("read EHOSTUNREACH"))).toThrow("EHOSTUNREACH");
    await pool.end();
  });
});
