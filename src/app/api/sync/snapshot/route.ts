import { headers } from "next/headers";
import { getRequestContext } from "@/modules/auth";
import { getTillSnapshot } from "@/modules/sales";
import { syncErrorResponse, TILL_TOKEN_HEADER } from "@/app/api/sync/sync-errors";

// GET /api/sync/snapshot: what a registered till keeps for selling offline
// (decision 0006). Session + till token, like the operations endpoint.
export async function GET(): Promise<Response> {
  const requestHeaders = await headers();
  const who = await getRequestContext(requestHeaders);
  if (who.kind !== "member") return Response.json({ code: "LOGIN", message: "Please log in." }, { status: 401 });
  try {
    const snapshot = await getTillSnapshot(who.ctx, requestHeaders.get(TILL_TOKEN_HEADER) ?? "");
    return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return syncErrorResponse(error, "till snapshot");
  }
}
