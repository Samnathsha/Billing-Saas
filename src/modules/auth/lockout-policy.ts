import { createHash } from "node:crypto";

// Per-account login limit (blueprint 5.2): failed logins are counted per
// email address, whether or not an account exists, so the limit itself
// never reveals which emails are registered.
//
// - The first 5 failures are free.
// - After that, each further attempt must wait longer since the last
//   failure: 1, 2, 4, 8, then 15 minutes (the maximum).
// - The counter is forgotten 1 hour after the last failure, and cleared by
//   a successful login.

export const LOCKOUT_POLICY = {
  freeFailures: 5,
  firstDelaySeconds: 60,
  maxDelaySeconds: 15 * 60,
  forgetAfterSeconds: 60 * 60,
} as const;

// Seconds to wait after the last failure, given the number of failures.
export function lockoutDelaySeconds(failures: number): number {
  if (failures < LOCKOUT_POLICY.freeFailures) return 0;
  const doublings = failures - LOCKOUT_POLICY.freeFailures;
  return Math.min(LOCKOUT_POLICY.firstDelaySeconds * 2 ** Math.min(doublings, 20), LOCKOUT_POLICY.maxDelaySeconds);
}

export function isLockedOut(failures: number, lastFailureMs: number, nowMs: number): boolean {
  if (nowMs - lastFailureMs >= LOCKOUT_POLICY.forgetAfterSeconds * 1000) return false;
  return nowMs - lastFailureMs < lockoutDelaySeconds(failures) * 1000;
}

// The email is stored only as a hash: repeated attempts can be linked
// without keeping the address.
export function emailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export function lockoutKey(email: string): string {
  return `login-fail:${emailHash(email)}`;
}
