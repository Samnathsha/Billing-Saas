// What the login screens show for an error from /api/auth/*. Only our own
// fixed texts are shown, chosen by the error's code or HTTP status; the
// server's own message is never displayed. None of them says whether an
// email address is registered.

export interface AuthErrorLike {
  status?: number;
  code?: string;
}

// Maps, not plain objects: a code like "toString" must not match a built-in.
const BY_CODE: ReadonlyMap<string, string> = new Map(Object.entries({
  INVALID_EMAIL_OR_PASSWORD: "Wrong email or password.",
  INVALID_EMAIL: "Please enter a valid email address.",
  EMAIL_NOT_VERIFIED: "Please confirm your email address first. You can send the link again below.",
  PASSWORD_TOO_SHORT: "Please use at least 12 characters.",
  PASSWORD_TOO_LONG: "Please use at most 128 characters.",
  PASSWORD_COMPROMISED: "This password has appeared in a data breach. Please choose a different one.",
  INVALID_TOKEN: "This link has expired or was already used. Please ask for a new one.",
  INVALID_PASSWORD: "Wrong password.",
  // Two-step login (Phase 11).
  INVALID_CODE: "That code is not right. Enter the 6-digit code your authenticator app shows now.",
  INVALID_BACKUP_CODE: "That backup code is not right, or it was already used.",
  ACCOUNT_TEMPORARILY_LOCKED: "Too many wrong codes. Two-step login is locked for 15 minutes.",
  INVALID_TWO_FACTOR_COOKIE: "This took too long. Please log in again.",
  TOTP_ALREADY_ENABLED: "Two-step login is already on.",
}));

const BY_STATUS: ReadonlyMap<number, string> = new Map([
  [429, "Too many attempts. Please wait a few minutes, then try again."],
  [403, "This request was refused. Please reload the page and try again."],
]);

export const GENERIC_AUTH_ERROR = "Something went wrong. Please try again.";

export function authErrorMessage(error: AuthErrorLike | null | undefined): string {
  if (error === null || error === undefined) return GENERIC_AUTH_ERROR;
  const byCode = error.code === undefined ? undefined : BY_CODE.get(error.code);
  if (byCode !== undefined) return byCode;
  const byStatus = error.status === undefined ? undefined : BY_STATUS.get(error.status);
  return byStatus ?? GENERIC_AUTH_ERROR;
}
