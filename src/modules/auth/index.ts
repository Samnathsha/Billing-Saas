// Public entry point of the auth module. Other code imports only from
// "@/modules/auth", never from files inside this folder.
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "./better-auth";

// Route handlers for /api/auth/* (sign up, sign in, sign out, verify email,
// reset password...), served by Better Auth.
export const authRouteHandlers = toNextJsHandler(auth);

export { createBusiness, createBusinessInput, OnboardingError, type OnboardingErrorCode } from "./onboarding";
export { getRequestContext, type RequestContext } from "./request-context";
export { PermissionDeniedError, requirePermission } from "./permissions";
export {
  endMySession,
  endSessionInput,
  listMySessions,
  logOutEverywhere,
  NotLoggedInError,
  type SessionDto,
} from "./my-sessions";
export { DEFAULT_ROLES, OWNER_ROLE, PERMISSIONS, type Permission } from "./default-roles";
export {
  changeMemberRole,
  changeMemberRoleInput,
  deactivateMember,
  deactivateMemberInput,
  MemberError,
  type MemberErrorCode,
} from "./service";
