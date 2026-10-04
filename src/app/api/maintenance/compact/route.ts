import { createHash, timingSafeEqual } from "node:crypto";
import { compactOldRows } from "@/modules/maintenance";
import { env } from "@/lib/env";

// GET /api/maintenance/compact: removes old technical rows (Phase 11,
// migration 0040). Called nightly by the hosting platform's cron or the
// Maintenance workflow with "Authorization: Bearer <CRON_SECRET>". Without
// CRON_SECRET configured the route does not exist (404).

const digest = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

export async function GET(request: Request): Promise<Response> {
  if (env.cronSecret === null) return new Response(null, { status: 404 });
  const given = request.headers.get("authorization") ?? "";
  // Same length digests: the comparison takes the same time either way.
  if (!timingSafeEqual(digest(given), digest(`Bearer ${env.cronSecret}`))) {
    return Response.json({ message: "Not allowed." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const removed = await compactOldRows();
    return Response.json({ status: "ok", removed }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    console.error("maintenance compact failed", code);
    return Response.json({ message: "Maintenance failed; it will run again tomorrow." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
