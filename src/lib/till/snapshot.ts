import type { TaxRateRow } from "@/lib/tax-pick";

// What a registered till keeps for selling offline (decision 0006;
// blueprint 8.5), as GET /api/sync/snapshot sends it. Built on the server
// (src/modules/sales/offline-core.ts) and kept by the till
// (src/lib/till/store.ts). Never cost prices.
export interface TillSnapshotDto {
  serverTime: string;
  till: { id: string; name: string; prefix: string; creditNotePrefix: string; branchId: string; branchName: string };
  user: { id: string; mayGiveAnyDiscount: boolean; mayReturnAfterWindow: boolean };
  settings: {
    ready: boolean;
    businessName: string;
    sellerAddress: string | null;
    gstin: string | null;
    stateCode: string | null;
    pricesIncludeTax: boolean;
    chargesGst: boolean;
    discountLimitBps: number;
    timeZone: string;
    financialYearStartMonth: number;
    returnWindowDays: number;
    offlineWindowHours: number;
  };
  // Never cost prices.
  items: { variantId: string; name: string; sku: string; codes: string[]; hsnCode: string | null; unitCode: string; allowsFraction: boolean; trackSerial: boolean; pricePaise: number; taxCategory: string }[];
  taxRates: Record<string, TaxRateRow[]>;
  serials: { serial: string; variantId: string }[];
  lastNumbers: { series: "invoice" | "credit_note"; financialYear: string; last: number }[];
  recentBills: {
    invoiceId: string;
    number: string;
    invoiceDate: string;
    payablePaise: number;
    lines: { invoiceItemId: string; lineNumber: number; name: string; sku: string; serial: string | null; unitCode: string; sold: string; returned: string; taxablePaise: number; cgstPaise: number; igstPaise: number; totalPaise: number }[];
  }[];
}
