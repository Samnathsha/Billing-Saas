import path from "node:path";
import { withSerwist } from "@serwist/turbopack";
import type { NextConfig } from "next";
import { apiContentSecurityPolicy, staticSecurityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  // Pin the project root so a stray lockfile in a parent folder is ignored.
  turbopack: {
    root: path.join(__dirname),
  },
  // Do not advertise the framework in an X-Powered-By header.
  poweredByHeader: false,
  headers() {
    return Promise.resolve([
      { source: "/:path*", headers: [...staticSecurityHeaders] },
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: apiContentSecurityPolicy }] },
    ]);
  },
};

// withSerwist: lets the service worker route bundle src/serwist/sw.ts.
export default withSerwist(nextConfig);
