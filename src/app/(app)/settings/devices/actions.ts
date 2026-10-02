"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { endMySession, logOutEverywhere, NotLoggedInError } from "@/modules/auth";

// The session id comes from the form, but endMySession only ever ends a
// session of the logged-in user (and checks the id strictly). If this
// device was itself logged out meanwhile, it goes to the login page.

export async function endSessionAction(form: FormData): Promise<void> {
  let target = "/settings/devices";
  try {
    const result = await endMySession(await headers(), { sessionId: form.get("sessionId") });
    if (result.ended && form.get("current") === "yes") target = "/login";
  } catch (error) {
    if (!(error instanceof NotLoggedInError)) throw error;
    target = "/login";
  }
  redirect(target);
}

export async function logOutEverywhereAction(): Promise<void> {
  try {
    await logOutEverywhere(await headers());
  } catch (error) {
    if (!(error instanceof NotLoggedInError)) throw error;
  }
  redirect("/login");
}
