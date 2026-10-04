// Safe messages for till and sync problems (shown to the user).

export type TillErrorCode = "PREFIX_TAKEN" | "BRANCH_CLOSED" | "NOT_FOUND" | "ALREADY_REVOKED" | "TILL_UNKNOWN" | "TILL_REVOKED" | "FLAG_RESOLVED" | "OP_ID_REUSED";

const MESSAGES: Record<TillErrorCode, string> = {
  PREFIX_TAKEN: "This prefix is already used by the business or another till (also as a credit-note prefix). Choose another.",
  BRANCH_CLOSED: "Choose an open branch.",
  NOT_FOUND: "Not found.",
  ALREADY_REVOKED: "This till is already revoked.",
  TILL_UNKNOWN: "This computer is not a registered till of this business. Register it again.",
  TILL_REVOKED: "This till has been revoked by a manager.",
  FLAG_RESOLVED: "This item was already reviewed.",
  OP_ID_REUSED: "This operation id was already used for something else.",
};

export class TillError extends Error {
  constructor(public readonly code: TillErrorCode) {
    super(MESSAGES[code]);
    this.name = "TillError";
  }
}
