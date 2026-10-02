import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/forms/form-parts";
import { ForgotPasswordForm } from "@/components/forms/forgot-password-form";

export const metadata: Metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard title="Forgot your password?">
      <ForgotPasswordForm />
      <Link href="/login" className="text-sm underline">Back to log in</Link>
    </AuthCard>
  );
}
