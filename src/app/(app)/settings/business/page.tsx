import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { BusinessProfileForm } from "@/components/forms/business-profile-form";
import { NotAllowed } from "@/components/not-allowed";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { GST_STATES } from "@/modules/tax";
import { getBusinessProfile, type BusinessProfileDto } from "@/modules/tenants";
import { saveBusinessProfile } from "./actions";

export const metadata: Metadata = { title: "Business settings" };

const STATES = [...GST_STATES].map(([code, name]) => ({ code, name }));

// Owner and Admin only ("Business and tax settings"); getBusinessProfile
// checks the permission on the server.
export default async function BusinessSettingsPage() {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  let profile: BusinessProfileDto;
  try {
    profile = await getBusinessProfile(who.ctx);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    throw error;
  }
  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Business settings</h1>
      <BusinessProfileForm profile={profile} states={STATES} save={saveBusinessProfile} />
    </main>
  );
}
