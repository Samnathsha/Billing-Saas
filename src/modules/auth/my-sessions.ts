import "server-only";
import { getIP } from "@better-auth/core/utils/ip";
import { z } from "zod";
import { auth } from "./better-auth";
import * as repo from "./repo";
import { getActiveSession, type ActiveSession } from "./request-context";

// "Your devices" (blueprint 5.2): the logged-in user sees their own
// sessions, can end one, or log out everywhere. Only ever the user's own
// sessions, so no business permission is needed; being logged in is the
// gate. Session tokens never leave the server: Better Auth's own
// /list-sessions and /revoke-session endpoints, which send and take tokens,
// are switched off in better-auth.ts and replaced by these.

export class NotLoggedInError extends Error {
  readonly code = "NOT_LOGGED_IN";
  constructor() {
    super("Please log in again.");
    this.name = "NotLoggedInError";
  }
}

export interface SessionDto {
  id: string;
  signedInAt: string; // ISO 8601
  lastActiveAt: string;
  ipAddress: string | null;
  device: string | null; // the browser's user-agent text, shortened
  current: boolean;
}

export const endSessionInput = z.strictObject({ sessionId: z.uuid() });

async function requireSession(headers: Headers): Promise<ActiveSession> {
  const session = await getActiveSession(headers);
  if (session === undefined) throw new NotLoggedInError();
  return session;
}

async function log(headers: Headers, event: string, userId: string, details: Record<string, unknown>): Promise<void> {
  await repo.addSecurityEvent({
    event,
    userId,
    ip: getIP(headers, auth.options),
    userAgent: headers.get("user-agent"),
    details,
  });
}

export async function listMySessions(headers: Headers): Promise<SessionDto[]> {
  const me = await requireSession(headers);
  const rows = await repo.listUserSessions(me.userId);
  return rows.map((r) => ({
    id: r.id,
    signedInAt: r.createdAt.toISOString(),
    lastActiveAt: r.updatedAt.toISOString(),
    ipAddress: r.ipAddress,
    device: r.userAgent?.slice(0, 200) ?? null,
    current: r.id === me.sessionId,
  }));
}

// Ends one of my sessions (e.g. a lost phone). Ending the current one logs
// this device out. An id that is not mine changes nothing and says so the
// same way as an id that does not exist.
export async function endMySession(headers: Headers, rawInput: unknown): Promise<{ ended: boolean }> {
  const me = await requireSession(headers);
  const { sessionId } = endSessionInput.parse(rawInput);
  const ended = await repo.deleteUserSession(me.userId, sessionId);
  if (ended) await log(headers, "auth.session_ended", me.userId, { sessionId, current: sessionId === me.sessionId });
  return { ended };
}

// Ends every session of mine, this one included.
export async function logOutEverywhere(headers: Headers): Promise<{ ended: number }> {
  const me = await requireSession(headers);
  const ended = await repo.deleteAllUserSessions(me.userId);
  await log(headers, "auth.logged_out_everywhere", me.userId, { sessions: ended });
  return { ended };
}
