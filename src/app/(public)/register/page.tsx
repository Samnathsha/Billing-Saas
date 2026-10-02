import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/forms/form-parts";
import { RegisterForm } from "@/components/forms/register-form";

export const metadata: Metadata = { title: "Create account" };

export default function RegisterPage() {
  return (
    <AuthCard title="Create your account">
      <RegisterForm />
      <p className="text-sm text-muted-foreground">
        Already have an account? <Link href="/login" className="underline">Log in</Link>
      </p>
    </AuthCard>
  );
}
