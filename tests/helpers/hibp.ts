import { createHash } from "node:crypto";

// Stand-in for the Have I Been Pwned range API in database tests, so tests
// never depend on the internet. The plugin's real code still runs; only the
// network reply is replaced. Installed by tests/setup-db-env.ts.

const RANGE_URL = "https://api.pwnedpasswords.com/range/";

interface HibpState {
  breached: Map<string, number>; // full SHA-1 (upper case) -> times seen
  down: boolean;
  requests: { url: string; headers: Headers }[];
}

const state: HibpState = { breached: new Map(), down: false, requests: [] };

function sha1(password: string): string {
  return createHash("sha1").update(password).digest("hex").toUpperCase();
}

export const hibp = {
  markBreached(password: string, times = 42): void {
    state.breached.set(sha1(password), times);
  },
  setDown(down: boolean): void {
    state.down = down;
  },
  requests(): readonly { url: string; headers: Headers }[] {
    return state.requests;
  },
  reset(): void {
    state.breached.clear();
    state.down = false;
    state.requests.length = 0;
  },
};

export function installHibpStandIn(): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(RANGE_URL)) return realFetch(input, init);
    state.requests.push({ url, headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
    if (state.down) return new Response("unavailable", { status: 503 });
    const prefix = url.slice(RANGE_URL.length).toUpperCase();
    const lines = [...state.breached]
      .filter(([hash]) => hash.startsWith(prefix))
      .map(([hash, times]) => `${hash.slice(5)}:${String(times)}`);
    // Like the real API with padding: some decoy lines with count 0.
    lines.push("0000000000000000000000000000000000A:0", "0000000000000000000000000000000000B:0");
    return new Response(lines.join("\r\n"), { status: 200, headers: { "Content-Type": "text/plain" } });
  });
}
