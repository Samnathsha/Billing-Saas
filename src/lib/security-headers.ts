// Security headers. The fixed headers are added to every response by
// next.config.ts. The Content Security Policy needs a fresh nonce per request,
// so src/proxy.ts builds it for every page.

export interface Header {
  key: string;
  value: string;
}

// Browsers whose list is empty may not use that feature at all. Open one up
// (e.g. camera=(self)) only when a feature needs it.
const DISABLED_FEATURES = [
  "accelerometer",
  "autoplay",
  "bluetooth",
  "browsing-topics",
  "camera",
  "display-capture",
  "encrypted-media",
  "geolocation",
  "gyroscope",
  "hid",
  "idle-detection",
  "local-fonts",
  "magnetometer",
  "microphone",
  "midi",
  "otp-credentials",
  "payment",
  "picture-in-picture",
  "publickey-credentials-create",
  "publickey-credentials-get",
  "screen-wake-lock",
  "serial",
  "usb",
  "window-management",
  "xr-spatial-tracking",
];

export const staticSecurityHeaders: readonly Header[] = [
  // Browsers use HTTPS only for this site for 2 years. No "preload": joining
  // the browser preload list is hard to undo and is a launch-time decision.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Same rule as CSP frame-ancestors 'none', for older browsers.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: DISABLED_FEATURES.map((feature) => `${feature}=()`).join(", ") },
  // Phase 11: another site's window cannot hold a handle to ours (and the
  // reverse), and our files may not be loaded by other sites.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Origin-Agent-Cluster", value: "?1" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];

// API routes return JSON, never HTML, so they may load nothing at all.
export const apiContentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'";

// 128 random bits, base64. A new one for every request.
export function createNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
}

// Policy from the Next.js 16 CSP guide. Development adds 'unsafe-eval' and
// inline styles because React's error overlay needs them; production does not.
// `https`: the app's own address is https (any real deployment), so every
// request is upgraded; local runs on http://localhost are not.
export function buildContentSecurityPolicy(nonce: string, isDev: boolean, https = false): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' ${isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    // style="..." attributes, which a nonce cannot cover. Next.js's own
    // <Image> and route announcer use them. They can change looks only; they
    // cannot run code, and img-src stops them loading anything off-site.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    // The till's service worker (decision 0006): only from this site.
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    // Nothing is framed or played inside the app.
    "frame-src 'none'",
    "media-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}
