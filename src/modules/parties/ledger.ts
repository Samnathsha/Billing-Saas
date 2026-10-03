import "server-only";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { PartyError } from "./errors";
import * as repo from "./repo";

// Inside-the-transaction helpers for other modules' services (purchases now,
// sales in Phase 7). They run only inside withTenant (a TenantTx exists
// nowhere else) after the caller checked permissions.

// Locks the supplier for the rest of the transaction. New purchases need an
// active supplier; a payment may settle an archived supplier's dues.
export async function lockSupplierFor(
  tx: TenantTx,
  supplierId: string,
  purpose: "purchase" | "payment",
): Promise<{ id: string; name: string; stateCode: string | null }> {
  const row = await repo.lockSupplier(tx, supplierId);
  if (row === undefined) throw new PartyError("NOT_FOUND");
  if (purpose === "purchase" && row.archivedAt !== null) throw new PartyError("ARCHIVED");
  return { id: row.id, name: row.name, stateCode: row.stateCode };
}

// Books one append-only row in the supplier's account. Positive = we owe
// the supplier more. Each source gets each entry type once.
export async function bookSupplierEntry(tx: TenantTx, ctx: TenantContext, entry: repo.LedgerEntryValues): Promise<void> {
  if (!Number.isSafeInteger(entry.amountPaise) || entry.amountPaise === 0) throw new Error("bookSupplierEntry: amount must be a non-zero whole number of paise");
  if (!(await repo.insertLedgerEntry(tx, ctx, entry))) throw new PartyError("ALREADY_BOOKED");
}
