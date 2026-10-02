// How long a login lasts (owner decision, 2026-10-02):
// - idle: logged out after 30 minutes without activity;
// - absolute: logged out 12 hours after logging in, even if active.

const MINUTE = 60;
const HOUR = 60 * MINUTE;

export const SESSION_POLICY = {
  // Better Auth's session lifetime, extended on use: the idle timeout.
  idleTimeoutSeconds: 30 * MINUTE,
  // Extend at most this often while in use (fewer database writes). The idle
  // cut-off therefore falls between 25 and 30 minutes of inactivity.
  refreshEverySeconds: 5 * MINUTE,
  // Maximum age from login. Enforced by the database (migration 0008 caps
  // sessions.expires_at at created_at + 12 hours: keep both in step) and by
  // getRequestContext, which also revokes the session.
  absoluteTimeoutSeconds: 12 * HOUR,
} as const;

export function isPastAbsoluteTimeout(createdAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - createdAt.getTime() >= SESSION_POLICY.absoluteTimeoutSeconds * 1000;
}

// Cookies are marked Secure (HTTPS only) whenever the app runs on https://,
// which production always does. Plain http is only for local development.
export function secureCookiesFor(appUrl: string): boolean {
  return new URL(appUrl).protocol === "https:";
}
