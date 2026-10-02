import "server-only";
import type { BetterAuthPlugin } from "better-auth";
import { appOrigin, isAllowedRequest } from "@/lib/origin-check";

// Better Auth's own check let a cross-site POST /sign-out through (found by
// tests/integration/my-sessions.test.ts). The proxy (src/proxy.ts) already
// refuses such requests; this plugin applies the same rule inside Better
// Auth's handler too, so its endpoints stay protected even if the proxy is
// bypassed or misconfigured.
export function originGuard(appUrl: string): BetterAuthPlugin {
  const allowed = appOrigin(appUrl);
  return {
    id: "origin-guard",
    onRequest: (request) => {
      if (isAllowedRequest(request.method, request.headers.get("origin"), allowed)) return Promise.resolve(undefined);
      return Promise.resolve({ response: Response.json({ message: "Request refused." }, { status: 403 }) });
    },
  };
}
