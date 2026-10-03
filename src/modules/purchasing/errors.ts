// Errors of the purchasing module with messages safe to show.

export type PurchaseErrorCode =
  | "REGISTRATION_NOT_SET"
  | "DUPLICATE_BILL"
  | "NOT_FOUND"
  | "ALREADY_VOIDED"
  | "DATE_IN_FUTURE"
  | "PAYMENT_ABOVE_TOTAL"
  | "SERIAL_COUNT"
  | "TOTAL_TOO_LARGE"
  | "ZERO_QUANTITY";

const MESSAGES: Record<PurchaseErrorCode, string> = {
  REGISTRATION_NOT_SET: "Set your GST registration in Business settings first: it decides how purchase cost is counted.",
  DUPLICATE_BILL: "This supplier bill number is already entered for this supplier.",
  NOT_FOUND: "This purchase was not found.",
  ALREADY_VOIDED: "This purchase is already voided.",
  DATE_IN_FUTURE: "The bill date cannot be in the future.",
  PAYMENT_ABOVE_TOTAL: "The amount paid now cannot be more than the bill total.",
  SERIAL_COUNT: "Enter one IMEI/serial number per unit.",
  TOTAL_TOO_LARGE: "This bill total is too large.",
  ZERO_QUANTITY: "Enter a quantity above zero.",
};

export class PurchaseError extends Error {
  constructor(public readonly code: PurchaseErrorCode) {
    super(MESSAGES[code]);
    this.name = "PurchaseError";
  }
}
