import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { appOrigin, isAllowedRequest } from "@/lib/origin-check";
import { buildContentSecurityPolicy, createNonce } from "@/lib/security-headers";

const ALLOWED_ORIGIN = appOrigin(env.authUrl);
const USES_HTTPS = new URL(env.authUrl).protocol === "https:";

// Runs before every page and API request.
// 1. Refuses state-changing requests (POST, PUT, ...) from any other site
//    (Origin check, src/lib/origin-check.ts).
// 2. For pages: creates a fresh nonce and sends the Content Security Policy.
//    Next.js reads the nonce from the request's CSP header and adds it to its
//    own scripts, so injected scripts without it are blocked.
export function proxy(request: NextRequest): NextResponse {
  if (!isAllowedRequest(request.method, request.headers.get("origin"), ALLOWED_ORIGIN)) {
    return NextResponse.json({ message: "Request refused." }, { status: 403 });
  }

  // API routes get a fixed, stricter CSP from next.config.ts.
  if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();

  const nonce = createNonce();
  const csp = buildContentSecurityPolicy(nonce, process.env.NODE_ENV === "development", USES_HTTPS);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Every API route (Origin check only).
    "/api/:path*",
    {
      // Pages, without static files and prefetches.
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
