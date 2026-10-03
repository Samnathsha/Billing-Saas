import "server-only";
import { headers } from "next/headers";
import { ZodError } from "zod";
import { rupeesToPaise } from "@/lib/money";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { InventoryError, StockError } from "@/modules/inventory";
import { PartyError } from "@/modules/parties";
import { PurchaseError } from "@/modules/purchasing";
import { SalesError, SeriesFullError } from "@/modules/sales";
import { TaxRateError } from "@/modules/tax";
import { IdempotencyError } from "@/modules/sync";

// Shared by the stock, supplier and purchase screen actions. Who and which
// business always come from the session, never from the form.

export interface ActionState {
  error: string | null;
  done: string | null;
}

export type MemberCtx = Extract<Awaited<ReturnType<typeof getRequestContext>>, { kind: "member" }>["ctx"];

export async function memberCtx(): Promise<MemberCtx | null> {
  const who = await getRequestContext(await headers());
  return who.kind === "member" ? who.ctx : null;
}

export const LOGGED_OUT: ActionState = { error: "Please log in again.", done: null };

// Choices left empty: the schemas' own messages are too technical here.
const CHOOSE: Record<string, string> = {
  supplierId: "Choose a supplier.",
  branchId: "Choose a branch.",
  variantId: "Choose an item.",
  method: "Choose how it was paid.",
  reasonCode: "Choose a reason.",
  direction: "Choose whether stock goes in or out.",
};

// A message safe to show. `names` turns an item id into what the user typed.
export function errorMessage(error: unknown, names?: Map<string, string>): string {
  if (error instanceof StockError) {
    const name = error.variantId === undefined ? undefined : names?.get(error.variantId);
    return name === undefined ? error.message : `${error.message} (${name})`;
  }
  if (
    error instanceof InventoryError ||
    error instanceof PurchaseError ||
    error instanceof SalesError ||
    error instanceof SeriesFullError ||
    error instanceof TaxRateError ||
    error instanceof PartyError ||
    error instanceof IdempotencyError ||
    error instanceof PermissionDeniedError
  ) {
    return error.message;
  }
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    if (issue === undefined) return "Please check the form.";
    const field = issue.path.at(-1);
    return (typeof field === "string" ? CHOOSE[field] : undefined) ?? issue.message;
  }
  console.error("action failed", error instanceof Error ? error.name : "unknown");
  return "Something went wrong. Nothing was saved. Please try again.";
}

export const formString = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

// Rupees typed -> paise. Empty -> null; a typing mistake -> -1, which the
// service refuses with a clear message instead of guessing.
export const formRupees = (form: FormData, name: string): number | null => {
  const raw = formString(form, name);
  return raw === "" ? null : (rupeesToPaise(raw) ?? -1);
};

// One IMEI/serial per line (or separated by commas/spaces).
export const formSerials = (form: FormData, name: string): string[] =>
  formString(form, name)
    .split(/[\s,]+/)
    .filter((s) => s !== "");
