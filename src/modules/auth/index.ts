// Public entry point of the auth module. Other code imports only from
// "@/modules/auth", never from files inside this folder.
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "./better-auth";

// Route handlers for /api/auth/* (sign up, sign in, sign out, verify email,
// reset password...), served by Better Auth.
export const authRouteHandlers = toNextJsHandler(auth);
