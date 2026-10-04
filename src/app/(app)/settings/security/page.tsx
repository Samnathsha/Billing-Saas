import type { Metadata } from "next";
import { headers } from "next/headers";
import { TwoFactorSettings } from "@/components/forms/two-factor-settings";
import { myTwoFactorEnabled } from "@/modules/auth";

export const metadata: Metadata = { title: "Two-step login" };

// The logged-in person's own two-step login (Phase 11; blueprint 5.2).
export default async function SecurityPage() {
  const enabled = await myTwoFactorEnabled(await headers());
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Two-step login</h1>
      <TwoFactorSettings enabled={enabled} />
    </main>
  );
}
