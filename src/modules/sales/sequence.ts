import "server-only";
import type { TenantContext, TenantTx } from "@/db/with-tenant";
import { formatDocumentNumber, MAX_NUMBER } from "./numbering";
import * as repo from "./repo";

// Takes the next bill (or credit note) number INSIDE the caller's
// transaction (business rule 5.3). The first number of a series is created
// on demand; later ones increment the row, which stays locked until the
// transaction ends. Two tills therefore queue for the number, and a sale
// that rolls back gives its number back: no gaps, no duplicates.

export class SeriesFullError extends Error {
  constructor() {
    super(`This bill series has reached ${String(MAX_NUMBER)} numbers this year. Change the bill prefix in Business settings.`);
    this.name = "SeriesFullError";
  }
}

export async function takeNextNumber(
  tx: TenantTx,
  ctx: TenantContext,
  series: { kind: "invoice" | "credit_note"; prefix: string; financialYear: string },
): Promise<{ number: number; formatted: string }> {
  const number = await repo.incrementSequence(tx, ctx, series, MAX_NUMBER);
  if (number === undefined) throw new SeriesFullError();
  return { number, formatted: formatDocumentNumber(series.prefix, series.financialYear, number) };
}
