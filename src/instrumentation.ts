import * as Sentry from "@sentry/nextjs";

// Next.js calls register() once when the server starts, before it serves any
// request. Node-only startup checks live in instrumentation-node.ts, because
// this file is also compiled for the Edge runtime. Error monitoring (Phase
// 11, src/sentry.server.config.ts) starts first, so startup failures are
// reported too.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}

// Server errors in pages, routes, actions and the proxy.
export const onRequestError = Sentry.captureRequestError;
