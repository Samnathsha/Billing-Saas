import "server-only";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";

// Sign-up must not reveal whether an email is already registered (blueprint
// Phase 3, test 8). For an existing email Better Auth answers with a made-up
// user, but our extra "status" field gave it away (null instead of
// "active"; tests/integration/enumeration.test.ts). So a successful sign-up
// answers only this fixed body, the same for every address, with no user
// data or id at all. Errors (weak or breached password, bad input) are left
// alone: they depend on the input, never on the address.
export const SIGN_UP_ANSWER = { status: "check-your-email" } as const;

export function uniformSignUp(): BetterAuthPlugin {
  return {
    id: "uniform-sign-up",
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path === "/sign-up/email",
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return;
            return ctx.json(SIGN_UP_ANSWER);
          }),
        },
      ],
    },
  };
}
