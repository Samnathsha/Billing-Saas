import Dexie, { type Table } from "dexie";
import type { TaxRateRow } from "@/lib/tax-pick";
import type { OfflineReturnOpShape, OfflineSaleOpShape } from "@/lib/offline-bill";

// The till's local store (decision 0006; blueprint 8.2, 8.5), in this
// browser's IndexedDB. It holds only what selling offline needs and the
// role may see: items with SELLING prices (never costs), tax rates, IMEIs
// in stock here, the business details for receipts, this till's recent
// bills (for offline returns), its numbers, and the outbox. Never a
// password. The till's token is kept as the server gave it; revoking the
// till on the server makes it useless.
//
// Saved here is NOT saved in the business: only an outbox entry the server
// confirmed is done.

export interface TillIdentity {
  key: "till";
  tillId: string;
  name: string;
  prefix: string;
  creditNotePrefix: string;
  branchId: string;
  branchName: string;
  token: string;
  // Set when the server answered "revoked": selling stops, the unsynced
  // list is shown, then the store is wiped.
  revoked: boolean;
}

// Who may sell offline on this till, from the last online contact.
export interface TillSession {
  key: "session";
  userId: string;
  mayGiveAnyDiscount: boolean;
  mayReturnAfterWindow: boolean;
  // This computer's clock at the last successful contact with the server.
  lastOnlineAt: number;
}

export interface TillSettings {
  key: "settings";
  ready: boolean;
  businessName: string;
  sellerAddress: string | null;
  gstin: string | null;
  pricesIncludeTax: boolean;
  chargesGst: boolean;
  discountLimitBps: number;
  timeZone: string;
  financialYearStartMonth: number;
  returnWindowDays: number;
  offlineWindowHours: number;
}

export type MetaRow = TillIdentity | TillSession | TillSettings;

export interface ItemRow {
  variantId: string;
  name: string;
  sku: string;
  // Upper case, for scanning: SKU and barcodes.
  codes: string[];
  hsnCode: string | null;
  unitCode: string;
  allowsFraction: boolean;
  trackSerial: boolean;
  pricePaise: number;
  taxCategory: string;
}

export interface RatesRow {
  category: string;
  rows: TaxRateRow[];
}

export interface SerialRow {
  // Upper case.
  serial: string;
  variantId: string;
  // Sold on this till offline (not yet confirmed by the server).
  soldHere: boolean;
}

export interface CounterRow {
  // "invoice|26-27" or "credit_note|26-27"
  key: string;
  last: number;
}

export interface KeptBillLineRow {
  invoiceItemId: string;
  lineNumber: number;
  name: string;
  sku: string;
  serial: string | null;
  unitCode: string;
  sold: string;
  // Returned so far, including this till's unsynced returns.
  returned: string;
  taxablePaise: number;
  cgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

export interface KeptBillRow {
  invoiceId: string;
  number: string;
  invoiceDate: string;
  payablePaise: number;
  lines: KeptBillLineRow[];
  // Made offline here and not yet confirmed by the server.
  pending: boolean;
}

export type OutboxStatus = "pending" | "failed" | "done";

export interface OutboxRow {
  seq?: number;
  opId: string;
  kind: "sale" | "return";
  // The bill (or credit note) number and the bill it belongs to.
  number: string;
  invoiceId: string;
  payload: OfflineSaleOpShape | OfflineReturnOpShape;
  createdAt: number;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  // What the server answered (flag codes) once done.
  flags: string[];
}

export class TillDb extends Dexie {
  meta!: Table<MetaRow, string>;
  items!: Table<ItemRow, string>;
  rates!: Table<RatesRow, string>;
  serials!: Table<SerialRow, string>;
  counters!: Table<CounterRow, string>;
  bills!: Table<KeptBillRow, string>;
  outbox!: Table<OutboxRow, number>;

  constructor(name = TILL_DB_NAME) {
    super(name);
    this.version(1).stores({
      meta: "key",
      items: "variantId, *codes",
      rates: "category",
      serials: "serial, variantId",
      counters: "key",
      bills: "invoiceId, invoiceDate",
      outbox: "++seq, &opId, status, invoiceId",
    });
  }
}

export const TILL_DB_NAME = "billing-till";

let shared: TillDb | null = null;

// One store per browser profile (the till).
export function tillDb(): TillDb {
  shared ??= new TillDb();
  return shared;
}

export async function readMeta<K extends MetaRow["key"]>(db: TillDb, key: K): Promise<Extract<MetaRow, { key: K }> | undefined> {
  return (await db.meta.get(key)) as Extract<MetaRow, { key: K }> | undefined;
}

// Removes everything this till keeps (after a revoke, once the unsynced
// list was shown), and the till page kept by the service worker.
export async function wipeTill(db: TillDb): Promise<void> {
  db.close();
  await Dexie.delete(db.name);
  shared = null;
  if (typeof caches !== "undefined") await caches.delete("till-pages");
}
