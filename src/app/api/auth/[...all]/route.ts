import { authRouteHandlers } from "@/modules/auth";

// Better Auth's endpoints: /api/auth/sign-up/email, /sign-in/email,
// /sign-out, /verify-email, /request-password-reset, /reset-password, ...
export const { GET, POST } = authRouteHandlers;
