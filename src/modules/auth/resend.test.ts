import { describe, expect, it } from "vitest";
import { EmailSendError, sendViaResend } from "./resend";

const CONFIG = { apiKey: "re_test_made_up_key_123", from: "Shop <noreply@example.com>" };
const EMAIL = { to: "owner@example.com", subject: "Confirm your email address", text: "Open this link: https://x/y" };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("sendViaResend", () => {
  it("sends one POST to Resend with the key, sender, recipient and text", async () => {
    const { impl, calls } = fakeFetch(() => Response.json({ id: "49a3999c" }));
    await sendViaResend(EMAIL, CONFIG, impl);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://api.resend.com/emails");
    expect(call?.init.method).toBe("POST");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_made_up_key_123");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(call?.init.body as string)).toEqual({ from: CONFIG.from, ...EMAIL });
  });

  it("uses a new idempotency key for each email", async () => {
    const { impl, calls } = fakeFetch(() => Response.json({ id: "x" }));
    await sendViaResend(EMAIL, CONFIG, impl);
    await sendViaResend(EMAIL, CONFIG, impl);
    const keys = calls.map((c) => (c.init.headers as Record<string, string>)["Idempotency-Key"]);
    expect(new Set(keys).size).toBe(2);
  });

  it.each([401, 403, 422, 429, 500])("a %i reply fails with a safe message", async (status) => {
    const { impl } = fakeFetch(() => new Response(JSON.stringify({ message: "detail" }), { status }));
    const error = await sendViaResend(EMAIL, CONFIG, impl).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as EmailSendError).status).toBe(status);
    expect(String(error)).not.toContain(CONFIG.apiKey);
    expect(String(error)).not.toContain(EMAIL.text);
  });

  it("a network failure fails with a safe message", async () => {
    const { impl } = fakeFetch(() => Promise.reject(new Error(`connect failed with ${CONFIG.apiKey}`)));
    const error = await sendViaResend(EMAIL, CONFIG, impl).catch((e: unknown) => e);
    expect((error as EmailSendError).status).toBe("network");
    expect(String(error)).not.toContain(CONFIG.apiKey);
  });
});
