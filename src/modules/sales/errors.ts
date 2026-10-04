// Errors of the sales module with messages safe to show.

export type SalesErrorCode =
  | "SETTINGS_INCOMPLETE"
  | "ITEM_NOT_FOUND"
  | "ITEM_ARCHIVED"
  | "ONE_IMEI_PER_LINE"
  | "BAD_BILL"
  | "PRICES_CHANGED"
  | "DISCOUNT_OVER_LIMIT"
  | "OVERPAID"
  | "CREDIT_NEEDS_CUSTOMER"
  | "DUPLICATE_INVOICE"
  | "NOT_FOUND"
  | "ALREADY_VOIDED"
  | "VOID_ONLY_SAME_DAY"
  | "RETURNS_EXIST"
  | "INVOICE_VOIDED"
  | "RETURN_WINDOW_PASSED"
  | "ITEM_NOT_ON_BILL"
  | "RETURN_TOO_MANY"
  | "STORE_CREDIT_NEEDS_CUSTOMER"
  | "CREDIT_NOTE_NOT_FOUND"
  | "EXCHANGE_BILL"
  // Offline tills (decision 0006).
  | "OFFLINE_BAD_NUMBER"
  | "OFFLINE_NUMBER_USED"
  | "OFFLINE_TOTAL_MISMATCH"
  | "OFFLINE_NOT_FULLY_PAID"
  | "OFFLINE_BAD_RATE"
  | "OFFLINE_GST_REGISTRATION_CHANGED"
  | "OFFLINE_UNKNOWN_SELLER"
  | "OFFLINE_NOT_THIS_TILL"
  | "OFFLINE_SALE_NOT_SYNCED";

const MESSAGES: Record<SalesErrorCode, string> = {
  SETTINGS_INCOMPLETE: "Set the business's state and GST registration in Business settings before billing.",
  ITEM_NOT_FOUND: "An item on this bill was not found.",
  ITEM_ARCHIVED: "An item on this bill is archived and cannot be sold.",
  ONE_IMEI_PER_LINE: "IMEI items are sold one per line, each with its IMEI/serial number.",
  BAD_BILL: "Please check the bill.",
  PRICES_CHANGED: "Prices or rates changed while this bill was open. Check the new total and save again.",
  DISCOUNT_OVER_LIMIT: "This discount is above your limit. Ask a manager.",
  OVERPAID: "The payments are more than the bill. Enter the amount kept (give the change back).",
  CREDIT_NEEDS_CUSTOMER: "Choose a customer to put the unpaid amount on their account.",
  DUPLICATE_INVOICE: "This bill was already saved.",
  NOT_FOUND: "This bill was not found.",
  ALREADY_VOIDED: "This bill is already voided.",
  VOID_ONLY_SAME_DAY: "A bill can be voided only on the day it was made. Use a return instead.",
  RETURNS_EXIST: "Items of this bill were already returned, so it cannot be voided. Use a return for the rest.",
  INVOICE_VOIDED: "This bill was voided; nothing can be returned against it.",
  RETURN_WINDOW_PASSED: "The return period for this bill has passed. Ask a manager.",
  ITEM_NOT_ON_BILL: "An item being returned is not on this bill.",
  RETURN_TOO_MANY: "That is more than was sold on this bill (earlier returns count).",
  STORE_CREDIT_NEEDS_CUSTOMER: "Store credit needs a customer on the bill. Give the money back instead.",
  CREDIT_NOTE_NOT_FOUND: "This credit note was not found.",
  EXCHANGE_BILL: "This bill was paid with returned items (an exchange), so it cannot be voided. Use a return instead.",
  OFFLINE_BAD_NUMBER: "The bill number does not belong to this till's series or does not match its date.",
  OFFLINE_NUMBER_USED: "This till already sent a bill with this number. Export it and show it to a manager.",
  OFFLINE_TOTAL_MISMATCH: "The bill's total does not add up. Export it and show it to a manager.",
  OFFLINE_NOT_FULLY_PAID: "An offline bill must be fully paid (no credit offline).",
  OFFLINE_BAD_RATE: "A GST rate on this bill is not one of the item's rates.",
  OFFLINE_GST_REGISTRATION_CHANGED: "The business's GST registration changed after this bill was made. A manager must enter it again.",
  OFFLINE_UNKNOWN_SELLER: "The person who made this bill is not a member of this business.",
  OFFLINE_NOT_THIS_TILL: "Only bills made on this till can be returned offline.",
  OFFLINE_SALE_NOT_SYNCED: "The bill being returned has not reached the server yet. It will be sent first.",
};

export class SalesError extends Error {
  constructor(
    public readonly code: SalesErrorCode,
    detail?: string,
  ) {
    super(detail === undefined ? MESSAGES[code] : `${MESSAGES[code]} ${detail}`);
    this.name = "SalesError";
  }
}
