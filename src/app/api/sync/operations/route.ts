import { headers } from "next/headers";
import { getRequestContext } from "@/modules/auth";
import { applyOfflineOperation } from "@/modules/sales";
import { syncErrorResponse, TILL_TOKEN_HEADER } from "@/app/api/sync/sync-errors";

// POST /api/sync/operations: ONE offline operation (a bill or a return)
// from a registered till (decision 0006). The business and the person come
// from the session; the till from its token header. Each operation is its
// own transaction; sending it again returns the first result.
const MAX_BYTES = 256 * 1024;

export async function POST(request: Request): Promise<Response> {
  const requestHeaders = await headers();
  const who = await getRequestContext(requestHeaders);
  if (who.kind !== "member") return Response.json({ code: "LOGIN", message: "Please log in." }, { status: 401 });
  const token = requestHeaders.get(TILL_TOKEN_HEADER) ?? "";
  const text = await request.text();
  if (text.length > MAX_BYTES) return Response.json({ code: "INVALID", message: "This operation is too large." }, { status: 422 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ code: "INVALID", message: "This operation is not in the expected form." }, { status: 422 });
  }
  try {
    const result = await applyOfflineOperation(who.ctx, token, body);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return syncErrorResponse(error, "offline operation");
  }
}
