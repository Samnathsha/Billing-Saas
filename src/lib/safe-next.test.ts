import { describe, expect, it } from "vitest";
import { invitePath, safeNextPath } from "./safe-next";

// Obviously fake (repetitive), so secret scanners do not mistake it for a key.
const TOKEN = `not_a_secret-${"x".repeat(20)}`;

describe("safeNextPath", () => {
  it("accepts an invitation link on this site", () => {
    expect(safeNextPath(invitePath(TOKEN))).toBe(`/invite?token=${TOKEN}`);
  });

  it.each([
    ["another site", "https://evil.example/invite?token=" + TOKEN],
    ["a protocol-relative link", "//evil.example/invite?token=" + TOKEN],
    ["a backslash trick", "/\\evil.example"],
    ["another page", "/settings/staff"],
    ["extra parameters", `/invite?token=${TOKEN}&next=https://evil.example`],
    ["a short token", "/invite?token=abc"],
    ["odd characters", `/invite?token=${TOKEN}%0d%0a`],
    ["javascript", "javascript:alert(1)"],
    ["nothing", undefined],
    ["a number", 42],
  ])("refuses %s", (_name, value) => {
    expect(safeNextPath(value)).toBeNull();
  });
});
