// Errors of the parties module with messages safe to show.

export type PartyErrorCode = "NAME_TAKEN" | "NOT_FOUND" | "ARCHIVED" | "STALE" | "OPENING_ALREADY_SET" | "ALREADY_BOOKED";

const MESSAGES: Record<PartyErrorCode, string> = {
  NAME_TAKEN: "A supplier with this name already exists (perhaps archived).",
  NOT_FOUND: "This supplier was not found.",
  ARCHIVED: "This supplier is archived. Restore it first.",
  STALE: "Someone else changed this supplier. Reload and try again.",
  OPENING_ALREADY_SET: "This supplier's opening balance is already recorded.",
  ALREADY_BOOKED: "This was already recorded in the supplier's account.",
};

export class PartyError extends Error {
  constructor(public readonly code: PartyErrorCode) {
    super(MESSAGES[code]);
    this.name = "PartyError";
  }
}
