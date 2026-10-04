import "server-only";
import { auth } from "./better-auth";
import { getActiveSession } from "./request-context";
import { NotLoggedInError } from "./my-sessions";

// Two-step login status for the logged-in person (Phase 11). Switching it
// on and off goes through Better Auth's own endpoints from the browser
// (password and code checked there, rate limited, secrets encrypted).
export async function myTwoFactorEnabled(headers: Headers): Promise<boolean> {
  if ((await getActiveSession(headers)) === undefined) throw new NotLoggedInError();
  const session = await auth.api.getSession({ headers });
  return session?.user.twoFactorEnabled === true;
}
