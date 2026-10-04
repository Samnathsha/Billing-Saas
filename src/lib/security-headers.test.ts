import { describe, expect, it } from "vitest";
import {
  apiContentSecurityPolicy,
  buildContentSecurityPolicy,
  createNonce,
  staticSecurityHeaders,
} from "./security-headers";

function header(key: string): string | undefined {
  return staticSecurityHeaders.find((h) => h.key === key)?.value;
}

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split(";").map((part) => {
      const [name = "", ...values] = part.trim().split(/\s+/);
      return [name, values.join(" ")];
    }),
  );
}

describe("static security headers", () => {
  it("HSTS for at least one year, including subdomains", () => {
    const hsts = header("Strict-Transport-Security") ?? "";
    const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(31_536_000);
    expect(hsts).toContain("includeSubDomains");
  });

  it("nosniff, no framing, strict referrer", () => {
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("X-Frame-Options")).toBe("DENY");
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("Permissions-Policy turns off camera, microphone, location and payment", () => {
    const policy = header("Permissions-Policy") ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });
});

describe("createNonce", () => {
  it("is 128 bits of base64 and different every time", () => {
    const nonces = new Set(Array.from({ length: 1000 }, createNonce));
    expect(nonces.size).toBe(1000);
    for (const nonce of nonces) {
      expect(Buffer.from(nonce, "base64")).toHaveLength(16);
    }
  });
});

describe("Content Security Policy", () => {
  const nonce = "dGVzdC1ub25jZS0xMjM0NQ==";

  describe.each([
    ["production", false],
    ["development", true],
  ])("%s", (_mode, isDev) => {
    const csp = directives(buildContentSecurityPolicy(nonce, isDev));

    it("scripts need the nonce; no inline scripts", () => {
      expect(csp.get("script-src")).toContain(`'nonce-${nonce}'`);
      expect(csp.get("script-src")).toContain("'strict-dynamic'");
      expect(csp.get("script-src")).not.toContain("'unsafe-inline'");
    });

    it("blocks framing, plugins and foreign form targets", () => {
      expect(csp.get("frame-ancestors")).toBe("'none'");
      expect(csp.get("object-src")).toBe("'none'");
      expect(csp.get("base-uri")).toBe("'self'");
      expect(csp.get("form-action")).toBe("'self'");
      expect(csp.get("default-src")).toBe("'self'");
    });

    it("the till's service worker and app manifest come only from this site", () => {
      expect(csp.get("worker-src")).toBe("'self'");
      expect(csp.get("manifest-src")).toBe("'self'");
    });
  });

  it("production allows no eval and no un-nonced <style> blocks", () => {
    const csp = directives(buildContentSecurityPolicy(nonce, false));
    expect(csp.get("script-src")).not.toContain("'unsafe-eval'");
    expect(csp.get("style-src")).toBe(`'self' 'nonce-${nonce}'`);
  });

  it("only style attributes are allowed inline, never scripts", () => {
    const csp = directives(buildContentSecurityPolicy(nonce, false));
    expect(csp.get("style-src-attr")).toBe("'unsafe-inline'");
    expect(csp.has("script-src-attr")).toBe(false);
    expect(csp.get("img-src")).toBe("'self' blob: data:");
  });

  it("development adds only what React's error overlay needs", () => {
    const csp = directives(buildContentSecurityPolicy(nonce, true));
    expect(csp.get("script-src")).toContain("'unsafe-eval'");
    expect(csp.get("style-src")).toBe("'self' 'unsafe-inline'");
  });

  it("API routes may load nothing and cannot be framed", () => {
    const csp = directives(apiContentSecurityPolicy);
    expect(csp.get("default-src")).toBe("'none'");
    expect(csp.get("frame-ancestors")).toBe("'none'");
  });
});
