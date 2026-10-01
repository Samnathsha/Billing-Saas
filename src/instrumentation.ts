// Next.js calls register() once when the server starts, before it serves any
// request. Node-only startup checks live in instrumentation-node.ts, because
// this file is also compiled for the Edge runtime.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
