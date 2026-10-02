import { describe, expect, it } from "vitest";
import { isPastAbsoluteTimeout, secureCookiesFor, SESSION_POLICY } from "./session-policy";

describe("session policy (owner decision: idle 30 min, max 12 h)", () => {
  it("has the decided values", () => {
    expect(SESSION_POLICY.idleTimeoutSeconds).toBe(30 * 60);
    expect(SESSION_POLICY.absoluteTimeoutSeconds).toBe(12 * 60 * 60);
    expect(SESSION_POLICY.refreshEverySeconds).toBeLessThan(SESSION_POLICY.idleTimeoutSeconds);
  });

  it.each([
    ["11 h 59 m 59 s", 12 * 3600 - 1, false],
    ["exactly 12 h", 12 * 3600, true],
    ["12 h 1 m", 12 * 3600 + 60, true],
    ["a few seconds", 5, false],
  ])("a session %s old is past the absolute timeout: %s", (_label, ageSeconds, expected) => {
    const now = new Date("2026-10-02T12:00:00Z");
    expect(isPastAbsoluteTimeout(new Date(now.getTime() - ageSeconds * 1000), now)).toBe(expected);
  });
});

describe("secure cookies", () => {
  it.each([
    ["https://billing.example.in", true],
    ["https://localhost:3000", true],
    ["http://localhost:3000", false],
  ])("%s -> Secure %s", (url, expected) => {
    expect(secureCookiesFor(url)).toBe(expected);
  });
});
