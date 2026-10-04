import "server-only";
import { getIP } from "@better-auth/core/utils/ip";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { sendEmail } from "./mailer";
import * as repo from "./repo";

// Better Auth plugin (Phase 11; OWASP ASVS 2.2.3 and 2.5.5): when a
// password is changed or two-step login is switched on or off, the person
// gets an email (so a change they did not make is noticed at once) and the
// security log records it. Wrong two-step codes and two-step logins are
// logged too. Password resets are notified from better-auth.ts
// (onPasswordReset), where the user is known.

type Ctx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

const NOTICES = {
  password_changed: { subject: "Your password was changed", text: "The password of your Billing account was just changed." },
  password_reset: { subject: "Your password was reset", text: "The password of your Billing account was just reset with an emailed link. All your devices were logged out." },
  two_factor_enabled: { subject: "Two-step login is now on", text: "Two-step login was just switched on for your Billing account. Logging in now needs a code from your authenticator app." },
  two_factor_disabled: { subject: "Two-step login was turned off", text: "Two-step login was just switched off for your Billing account. Logging in now needs only your password." },
} as const;
export type SecurityNotice = keyof typeof NOTICES;

const CLOSING = "\n\nIf this was not you, reset your password at once and tell the business owner.";

export async function sendSecurityNotice(to: string, notice: SecurityNotice): Promise<void> {
  await sendEmail({ to, subject: NOTICES[notice].subject, text: NOTICES[notice].text + CLOSING });
}

function where(ctx: Ctx): { ip: string | null; userAgent: string | null } {
  return { ip: ctx.headers === undefined ? null : getIP(ctx.headers, ctx.context.options), userAgent: ctx.headers?.get("user-agent") ?? null };
}

// The code step of a login carries the two-step cookie; switching two-step
// login on is done from an ordinary logged-in session.
const duringLogin = (ctx: Ctx): boolean => /(^|;\s*)(__Secure-)?[\w.-]*two_factor=/.test(ctx.headers?.get("cookie") ?? "");

const CODE_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);

export function securityNotices(): BetterAuthPlugin {
  return {
    id: "security-notices",
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path === "/change-password" || ctx.path === "/two-factor/disable",
          handler: createAuthMiddleware(async (ctx) => {
            const user = ctx.context.session?.user;
            if (isAPIError(ctx.context.returned) || user?.email === undefined) return;
            const notice: SecurityNotice = ctx.path === "/change-password" ? "password_changed" : "two_factor_disabled";
            await repo.addSecurityEvent({ event: `auth.${notice}`, userId: user.id, ...where(ctx), details: null });
            await sendSecurityNotice(user.email, notice);
          }),
        },
        {
          matcher: (ctx) => CODE_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const place = where(ctx);
            const login = duringLogin(ctx);
            if (isAPIError(ctx.context.returned)) {
              await repo.addSecurityEvent({ event: "auth.two_factor_failed", ...place, details: { duringLogin: login } });
              return;
            }
            const user = ctx.context.newSession?.user;
            if (user === undefined) return;
            if (login) {
              await repo.addSecurityEvent({ event: "auth.login_succeeded", userId: user.id, ...place, details: { twoFactor: true } });
              return;
            }
            await repo.addSecurityEvent({ event: "auth.two_factor_enabled", userId: user.id, ...place, details: null });
            await sendSecurityNotice(user.email, "two_factor_enabled");
          }),
        },
      ],
    },
  };
}
