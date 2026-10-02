import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { BusinessProfileForm } from "@/components/forms/business-profile-form";
import { NotAllowed } from "@/components/not-allowed";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { GST_STATES } from "@/modules/tax";
import { getBusinessProfile, getPlanUsage, type BusinessProfileDto, type PlanUsageDto } from "@/modules/tenants";
import { saveBusinessProfile } from "./actions";

export const metadata: Metadata = { title: "Business settings" };

const STATES = [...GST_STATES].map(([code, name]) => ({ code, name }));

// Owner and Admin only ("Business and tax settings"); getBusinessProfile
// checks the permission on the server.
const LABELS = { branches: "Branches", users: "Staff (owner included)", devices: "Tills" } as const;

function PlanBox({ plan }: { plan: PlanUsageDto | null }) {
  if (plan === null) return <p className="text-sm text-destructive">This business has no plan. Please contact support.</p>;
  return (
    <section aria-label="Your plan" className="flex max-w-xl flex-col gap-2 rounded-lg border p-4">
      <h2 className="font-semibold">Your plan: {plan.planName}</h2>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        {plan.usage.map((u) => (
          <div key={u.resource} className="contents">
            <dt className="text-muted-foreground">{LABELS[u.resource]}</dt>
            <dd>
              {u.used} of {u.limit}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default async function BusinessSettingsPage() {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  let profile: BusinessProfileDto;
  let plan: PlanUsageDto | null;
  try {
    profile = await getBusinessProfile(who.ctx);
    plan = await getPlanUsage(who.ctx);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    throw error;
  }
  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Business settings</h1>
      <PlanBox plan={plan} />
      <BusinessProfileForm profile={profile} states={STATES} save={saveBusinessProfile} />
    </main>
  );
}
