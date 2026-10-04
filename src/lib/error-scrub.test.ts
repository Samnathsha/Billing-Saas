import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import { scrubEvent, scrubText } from "./error-scrub";

describe("error reports carry no personal data", () => {
  it("texts lose emails, phones, IMEIs, GSTINs, tokens and connection strings", () => {
    expect(scrubText("duplicate key (email)=(asha.k@shop.in)")).toBe("duplicate key (email)=([email])");
    expect(scrubText("phone +91 98400 00000 and IMEI 356938035643809")).toBe("phone [number] and IMEI [number]");
    expect(scrubText("GSTIN 33ABCDE1234F1Z7 refused")).toBe("GSTIN [gstin] refused");
    expect(scrubText("token Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg")).toBe("token [token]");
    expect(scrubText("connect postgresql://app_user:secret@host/db failed")).toBe("connect [connection] failed");
    // Ordinary error text stays readable.
    expect(scrubText("Cannot read properties of undefined (reading 'lines') at line 42")).toBe("Cannot read properties of undefined (reading 'lines') at line 42");
  });

  it("an event keeps the error and where, and loses who, cookies, bodies and queries", () => {
    const event = {
      type: undefined,
      message: "failed for 98400 12345",
      user: { id: "u1", email: "a@b.in", ip_address: "1.2.3.4" },
      extra: { body: "secret" },
      request: {
        method: "POST",
        url: "https://app.example/verify-email?token=abc",
        query_string: "token=abc",
        cookies: { "billing.session_token": "s" },
        data: { password: "p" },
        headers: { cookie: "billing.session_token=s", "x-till-token": "t", "user-agent": "Chrome" },
      },
      exception: { values: [{ type: "Error", value: "no customer 9840012345", stacktrace: { frames: [{ filename: "app/x.ts", lineno: 3 }] } }] },
      breadcrumbs: [{ category: "fetch", message: "to a@b.in", data: { url: "/api/sync/snapshot?x=1", method: "GET", status_code: 500, body: "b" } }],
    } as unknown as ErrorEvent;
    const out = scrubEvent(event);
    expect(out.user).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(out.request).toEqual({ method: "POST", url: "https://app.example/verify-email", headers: { "user-agent": "Chrome" } });
    expect(out.message).toBe("failed for [number]");
    expect(out.exception?.values?.[0]).toMatchObject({ type: "Error", value: "no customer [number]", stacktrace: { frames: [{ filename: "app/x.ts", lineno: 3 }] } });
    expect(out.breadcrumbs?.[0]).toMatchObject({ message: "to [email]", data: { url: "/api/sync/snapshot", method: "GET", status_code: 500 } });
    expect(JSON.stringify(out)).not.toMatch(/secret|password|session_token|x-till-token|a@b\.in|1\.2\.3\.4/);
  });
});
