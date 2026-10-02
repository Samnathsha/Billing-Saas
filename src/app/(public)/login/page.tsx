import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/forms/form-parts";
import { LoginForm } from "@/components/forms/login-form";

export const metadata: Metadata = { title: "Log in" };

export default function LoginPage() {
  return (
    <AuthCard title="Log in">
      <LoginForm />
      <p className="text-sm text-muted-foreground">
        New here? <Link href="/register" className="underline">Create an account</Link>
      </p>
    </AuthCard>
  );
}
