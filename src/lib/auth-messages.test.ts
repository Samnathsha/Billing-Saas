import { describe, expect, it } from "vitest";
import { authErrorMessage, GENERIC_AUTH_ERROR } from "./auth-messages";

describe("authErrorMessage", () => {
  it.each([
    ["INVALID_EMAIL_OR_PASSWORD", "Wrong email or password."],
    ["PASSWORD_TOO_SHORT", "Please use at least 12 characters."],
    ["PASSWORD_COMPROMISED", "This password has appeared in a data breach. Please choose a different one."],
    ["INVALID_TOKEN", "This link has expired or was already used. Please ask for a new one."],
  ])("code %s has a fixed text", (code, text) => {
    expect(authErrorMessage({ code, status: 400 })).toBe(text);
  });

  it("rate limits and refusals are explained by status", () => {
    expect(authErrorMessage({ status: 429 })).toContain("Too many attempts");
    expect(authErrorMessage({ status: 403 })).toContain("refused");
  });

  it("the code wins over the status", () => {
    expect(authErrorMessage({ code: "EMAIL_NOT_VERIFIED", status: 403 })).toContain("confirm your email");
  });

  it("anything unknown gets the generic text, never the server's own words", () => {
    expect(authErrorMessage({ code: "SOME_INTERNAL_THING", status: 500 })).toBe(GENERIC_AUTH_ERROR);
    expect(authErrorMessage({ code: "__proto__" })).toBe(GENERIC_AUTH_ERROR);
    expect(authErrorMessage({ code: "toString" })).toBe(GENERIC_AUTH_ERROR);
    expect(authErrorMessage({})).toBe(GENERIC_AUTH_ERROR);
    expect(authErrorMessage(null)).toBe(GENERIC_AUTH_ERROR);
  });

  it("no message tells whether an email is registered", () => {
    for (const code of ["INVALID_EMAIL_OR_PASSWORD", "INVALID_TOKEN"]) {
      expect(authErrorMessage({ code })).not.toMatch(/no account|not registered|does not exist|unknown email/i);
    }
  });
});
