// Where the login page may send someone afterwards. Only an invitation link
// on this site is accepted, so the login page can never be used to send
// people to another site (open redirect).
const INVITE_PATH = /^\/invite\?token=[A-Za-z0-9_-]{20,200}$/;

export function safeNextPath(value: unknown): string | null {
  return typeof value === "string" && INVITE_PATH.test(value) ? value : null;
}

export const invitePath = (token: string): string => `/invite?token=${token}`;
