import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/forms/form-parts";
import { SetupForm } from "@/components/forms/setup-form";
import { getRequestContext } from "@/modules/auth";
import { setUpBusiness } from "./actions";

export const metadata: Metadata = { title: "Set up your business" };

export default async function SetupPage() {
  const who = await getRequestContext(await headers());
  if (who.kind === "anonymous") redirect("/login");
  if (who.kind === "member") redirect("/dashboard");
  return (
    <AuthCard title="Set up your business">
      <SetupForm setUpBusiness={setUpBusiness} />
    </AuthCard>
  );
}
