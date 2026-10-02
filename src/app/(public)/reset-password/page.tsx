import type { Metadata } from "next";
import { AuthCard, FormMessage } from "@/components/forms/form-parts";
import { ForgotPasswordForm } from "@/components/forms/forgot-password-form";
import { ResetPasswordForm } from "@/components/forms/reset-password-form";

export const metadata: Metadata = { title: "Reset password" };

// Where the reset link lands after Better Auth has checked it:
// ?token=... when valid, ?error=... when expired or already used.
export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const { token, error } = await searchParams;
  if (error !== undefined || typeof token !== "string" || token === "") {
    return (
      <AuthCard title="This link did not work">
        <FormMessage kind="error" text="The link has expired or was already used. Enter your email to get a new one." />
        <ForgotPasswordForm buttonText="Send a new link" />
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Choose a new password">
      <ResetPasswordForm token={token} />
    </AuthCard>
  );
}
