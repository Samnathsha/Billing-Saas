import { strToU8, zipSync } from "fflate";
import { headers } from "next/headers";
import { toCsv } from "@/lib/csv-write";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { BusinessDataError, exportBusinessData } from "@/modules/tenants";

// GET /api/business/export: everything this business has stored, one CSV
// file per table in a ZIP (Phase 11; OWASP ASVS 8.3.2). Owner only, at most
// once every 10 minutes, audited (exportBusinessData). The business comes
// from the session.

const README = `This archive holds every record of your business in the billing app,
one spreadsheet (CSV) file per kind of record, e.g. invoices.csv (bills),
invoice_items.csv (their lines), customers.csv, stock_movements.csv.
Amounts ending in _paise are in paise (100 paise = 1 rupee).
Dates and times are in UTC. Ids link records between files.
Not included: passwords, login sessions and secret keys.
Keep this file safe: it contains your customers' details.
`;

export async function GET(): Promise<Response> {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") return Response.json({ message: "Please log in." }, { status: 401 });
  try {
    const data = await exportBusinessData(who.ctx);
    const files: Record<string, Uint8Array> = { "README.txt": strToU8(README) };
    for (const [name, rows] of data.files) files[name] = strToU8(toCsv(rows));
    const zip = zipSync(files, { level: 6 });
    return new Response(Buffer.from(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${data.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return Response.json({ message: "Only the owner can export the business." }, { status: 403 });
    if (error instanceof BusinessDataError) return Response.json({ message: error.message }, { status: 429 });
    console.error("business export failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ message: "Something went wrong." }, { status: 500 });
  }
}
