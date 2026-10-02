// CSRF defence, second layer (blueprint 5.2): every state-changing request
// must carry an Origin header equal to the app's own address. Browsers send
// Origin on every POST/PUT/PATCH/DELETE, including same-site ones, so a
// missing Origin is refused too. The first layer is the SameSite=Lax
// session cookie. Better Auth and Next.js Server Actions also check Origin
// themselves; this check covers every route, including future API routes.

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

// The origin ("https://shop.example.in") of the configured app URL.
export function appOrigin(appUrl: string): string {
  return new URL(appUrl).origin;
}

export function isAllowedRequest(method: string, originHeader: string | null, allowedOrigin: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  // "null" (sandboxed frames, some redirects) and anything else that is not
  // exactly our origin is refused.
  return originHeader !== null && originHeader === allowedOrigin;
}
