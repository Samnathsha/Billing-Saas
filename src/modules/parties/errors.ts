// Errors of the parties module with messages safe to show.

export type PartyErrorCode =
  | "NAME_TAKEN"
  | "NOT_FOUND"
  | "ARCHIVED"
  | "STALE"
  | "OPENING_ALREADY_SET"
  | "ALREADY_BOOKED"
  | "PHONE_TAKEN"
  | "CREDIT_NOT_ALLOWED"
  | "OVER_CREDIT_LIMIT";

const MESSAGES: Record<PartyErrorCode, string> = {
  NAME_TAKEN: "A supplier with this name already exists (perhaps archived).",
  NOT_FOUND: "This supplier or customer was not found.",
  ARCHIVED: "This is archived. Restore it first.",
  STALE: "Someone else changed this. Reload and try again.",
  OPENING_ALREADY_SET: "This supplier's opening balance is already recorded.",
  ALREADY_BOOKED: "This was already recorded in the account.",
  PHONE_TAKEN: "Another customer already has this phone number.",
  CREDIT_NOT_ALLOWED: "Only a manager or above can change a customer's credit limit.",
  OVER_CREDIT_LIMIT: "This would take the customer over their credit limit.",
};

export class PartyError extends Error {
  constructor(public readonly code: PartyErrorCode) {
    super(MESSAGES[code]);
    this.name = "PartyError";
  }
}
