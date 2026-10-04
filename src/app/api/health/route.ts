import * as Sentry from "@sentry/nextjs";
import { env } from "@/lib/env";

// Liveness check for uptime monitors and the hosting platform. It answers
// only "the server is running": no version, database or system details,
// which would help an attacker. Other methods get 405 from Next.js.
// HEALTH_DRILL=fail answers 503 on purpose, to prove the uptime alert works,
// and sends one message to error monitoring (if set up) to prove that too.
export function GET(): Response {
  if (env.healthDrill) {
    Sentry.captureMessage("Health drill: /api/health answered 503 on purpose", "warning");
    return Response.json({ status: "drill" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
