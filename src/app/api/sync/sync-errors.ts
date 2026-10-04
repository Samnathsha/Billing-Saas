import { ZodError } from "zod";
import { PermissionDeniedError } from "@/modules/auth";
import { InventoryError, StockError } from "@/modules/inventory";
import { SalesError } from "@/modules/sales";
import { TillError } from "@/modules/sync";
import { TaxRateError } from "@/modules/tax";

// How the till's sync engine reads an answer (decision 0006):
// - 401 / 403: log in again (or not allowed); nothing is lost, it waits;
// - 410: this till was revoked: show what is unsynced, then wipe;
// - 409: try again later (a return whose bill has not arrived yet);
// - 422: refused, will never succeed as it is: goes to the failed list;
// - 5xx or no answer: try again with backoff.
// Messages are safe to show; details go to the server log by code only.
export function syncErrorResponse(error: unknown, what: string): Response {
  const json = (status: number, code: string, message: string) => Response.json({ code, message }, { status, headers: { "Cache-Control": "no-store" } });
  if (error instanceof PermissionDeniedError) return json(403, "FORBIDDEN", error.message);
  if (error instanceof TillError) {
    if (error.code === "TILL_REVOKED") return json(410, error.code, error.message);
    if (error.code === "TILL_UNKNOWN") return json(403, error.code, error.message);
    return json(422, error.code, error.message);
  }
  if (error instanceof SalesError) return json(error.code === "OFFLINE_SALE_NOT_SYNCED" ? 409 : 422, error.code, error.message);
  if (error instanceof StockError || error instanceof InventoryError || error instanceof TaxRateError) return json(422, error.code, error.message);
  if (error instanceof ZodError) return json(422, "INVALID", "This operation is not in the expected form.");
  console.error(`${what} failed`, error instanceof Error ? error.name : "unknown");
  return json(500, "SERVER", "Something went wrong. It will be tried again.");
}

export const TILL_TOKEN_HEADER = "x-till-token";
