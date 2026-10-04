import "server-only";
import { getIP } from "@better-auth/core/utils/ip";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { emailHash, isLockedOut, lockoutKey, LOCKOUT_POLICY } from "./lockout-policy";
import * as repo from "./repo";

// Better Auth plugin: per-account login limit (lockout-policy.ts) and the
// security log for logins (security_events, review question R6). Better
// Auth's own limiter covers the per-IP side.

const SIGN_IN = "/sign-in/email";
// The same answer Better Auth's IP limiter gives, so the two cannot be told
// apart and nothing reveals whether the email exists.
const TOO_MANY = "Too many requests. Please try again later.";

function emailFrom(body: unknown): string | undefined {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" && email.length > 0 ? email : undefined;
}

export function accountLockout(): BetterAuthPlugin {
  return {
    id: "account-lockout",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === SIGN_IN,
          handler: createAuthMiddleware(async (ctx) => {
            const email = emailFrom(ctx.body);
            if (email === undefined) return;
            const failures = await repo.getLoginFailures(lockoutKey(email));
            if (failures !== undefined && isLockedOut(failures.count, failures.lastRequest, Date.now())) {
              await repo.addSecurityEvent({
                event: "auth.login_locked",
                emailHash: emailHash(email),
                ip: ctx.headers === undefined ? null : getIP(ctx.headers, ctx.context.options),
                userAgent: ctx.headers?.get("user-agent") ?? null,
                details: { failures: failures.count },
              });
              throw new APIError("TOO_MANY_REQUESTS", { message: TOO_MANY });
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === SIGN_IN,
          handler: createAuthMiddleware(async (ctx) => {
            const email = emailFrom(ctx.body);
            if (email === undefined) return;
            const ip = ctx.headers === undefined ? null : getIP(ctx.headers, ctx.context.options);
            const userAgent = ctx.headers?.get("user-agent") ?? null;
            const returned = ctx.context.returned;

            if (isAPIError(returned)) {
              // Only a wrong email/password counts (same code for unknown
              // emails). "Email not verified" means the password was right.
              if (returned.body?.code !== "INVALID_EMAIL_OR_PASSWORD") return;
              const count = await repo.recordLoginFailure(lockoutKey(email), LOCKOUT_POLICY.forgetAfterSeconds);
              await repo.addSecurityEvent({
                event: "auth.login_failed",
                emailHash: emailHash(email),
                ip,
                userAgent,
                details: { failures: count },
              });
              return;
            }

            // The password was right: the failure count starts again, also
            // when two-step login still asks for a code (that success is
            // logged by security-notices.ts).
            await repo.clearLoginFailures(lockoutKey(email));
            const userId = ctx.context.newSession?.user.id;
            if (userId === undefined) return;
            await repo.addSecurityEvent({ event: "auth.login_succeeded", userId, ip, userAgent, details: null });
          }),
        },
      ],
    },
  };
}
