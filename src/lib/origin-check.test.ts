import { describe, expect, it } from "vitest";
import { appOrigin, isAllowedRequest } from "./origin-check";

const APP = "https://shop.example.in";

describe("appOrigin", () => {
  it("keeps scheme, host and port only", () => {
    expect(appOrigin("https://shop.example.in/some/path?x=1")).toBe(APP);
    expect(appOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });
});

describe("isAllowedRequest", () => {
  it.each(["GET", "HEAD", "OPTIONS", "get"])("%s needs no Origin (reads only)", (method) => {
    expect(isAllowedRequest(method, null, APP)).toBe(true);
    expect(isAllowedRequest(method, "https://evil.example", APP)).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "post"])("%s from our own origin is allowed", (method) => {
    expect(isAllowedRequest(method, APP, APP)).toBe(true);
  });

  it.each([
    ["another site", "https://evil.example"],
    ["a look-alike subdomain", "https://shop.example.in.evil.example"],
    ["our site over plain http", "http://shop.example.in"],
    ["another port", "https://shop.example.in:8443"],
    ["a sub-domain", "https://admin.shop.example.in"],
    ["the literal null origin", "null"],
    ["a trailing slash", "https://shop.example.in/"],
    ["an empty header", ""],
  ])("POST from %s is refused", (_name, origin) => {
    expect(isAllowedRequest("POST", origin, APP)).toBe(false);
  });

  it("a write without any Origin header is refused", () => {
    expect(isAllowedRequest("POST", null, APP)).toBe(false);
    expect(isAllowedRequest("DELETE", null, APP)).toBe(false);
  });

  it("an unknown method counts as a write", () => {
    expect(isAllowedRequest("PROPFIND", "https://evil.example", APP)).toBe(false);
  });
});
