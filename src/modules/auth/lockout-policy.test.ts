import { describe, expect, it } from "vitest";
import { emailHash, isLockedOut, lockoutDelaySeconds, lockoutKey } from "./lockout-policy";

describe("lockout delay after failed logins", () => {
  it.each([
    [0, 0],
    [4, 0],
    [5, 60],
    [6, 120],
    [7, 240],
    [8, 480],
    [9, 900],
    [10, 900],
    [1000, 900],
  ])("%i failures -> wait %i seconds", (failures, seconds) => {
    expect(lockoutDelaySeconds(failures)).toBe(seconds);
  });
});

describe("isLockedOut", () => {
  const now = 1_000_000_000_000;
  const ago = (seconds: number): number => now - seconds * 1000;

  it("not locked before 5 failures", () => {
    expect(isLockedOut(4, ago(0), now)).toBe(false);
  });

  it("locked during the delay, free right after it", () => {
    expect(isLockedOut(5, ago(59), now)).toBe(true);
    expect(isLockedOut(5, ago(60), now)).toBe(false);
    expect(isLockedOut(6, ago(119), now)).toBe(true);
    expect(isLockedOut(6, ago(120), now)).toBe(false);
  });

  it("never waits longer than 15 minutes, however many failures", () => {
    expect(isLockedOut(50, ago(899), now)).toBe(true);
    expect(isLockedOut(50, ago(900), now)).toBe(false);
  });

  // Forgetting the counter itself after 1 hour is tested against the
  // database in tests/integration/rate-limits.test.ts.
  it("an hour after the last failure nothing is locked", () => {
    expect(isLockedOut(50, ago(3600), now)).toBe(false);
  });
});

describe("email hashing", () => {
  it("ignores case and surrounding spaces, and never contains the address", () => {
    expect(emailHash("  Owner@Shop.IN ")).toBe(emailHash("owner@shop.in"));
    expect(emailHash("owner@shop.in")).toMatch(/^[0-9a-f]{64}$/);
    expect(lockoutKey("owner@shop.in")).not.toContain("owner");
  });
});
