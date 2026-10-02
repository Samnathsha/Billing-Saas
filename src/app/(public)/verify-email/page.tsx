import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard, FormMessage } from "@/components/forms/form-parts";
import { ResendVerificationForm } from "@/components/forms/resend-verification-form";

export const metadata: Metadata = { title: "Confirm email" };

// Where the confirmation link lands after Better Auth has checked it. On a
// bad or expired link Better Auth adds ?error=...; the value itself is never
// shown, only whether there was one.
export default async function VerifyEmailPage({ searchParams }: PageProps<"/verify-email">) {
  const { error } = await searchParams;
  if (error !== undefined) {
    return (
      <AuthCard title="This link did not work">
        <FormMessage kind="error" text="The link has expired or was already used. Enter your email to get a new one." />
        <ResendVerificationForm />
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Email confirmed">
      <FormMessage kind="info" text="Thank you. Your email address is confirmed." />
      <Link href="/login" className="underline">Log in</Link>
    </AuthCard>
  );
}
