import { beforeEach, describe, expect, it, vi } from "vitest";

// The route reads only the drill switch from the settings.
const settings = vi.hoisted(() => ({ healthDrill: false }));
vi.mock("@/lib/env", () => ({ env: settings }));

const { GET } = await import("./route");

describe("GET /api/health", () => {
  beforeEach(() => {
    settings.healthDrill = false;
  });

  it('returns exactly {"status":"ok"} as JSON', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).toBe('{"status":"ok"}');
  });

  it("is never cached", () => {
    expect(GET().headers.get("cache-control")).toBe("no-store");
  });

  it("the alert drill (HEALTH_DRILL=fail) answers 503 on purpose", async () => {
    settings.healthDrill = true;
    const response = GET();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"status":"drill"}');
  });
});
