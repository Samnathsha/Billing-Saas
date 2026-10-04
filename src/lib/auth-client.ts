import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Browser side of the login screens: calls /api/auth/* on this same site.
// The forms go through the real HTTP endpoints on purpose, so every
// protection stays in front of them: per-IP limits, the Origin check, the
// account lockout and the uniform answers (docs/auth.md). Server code uses
// the auth module instead, never this file.
export const authClient = createAuthClient({ plugins: [twoFactorClient()] });
