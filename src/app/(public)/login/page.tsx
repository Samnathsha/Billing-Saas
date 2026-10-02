import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/forms/form-parts";
import { LoginForm } from "@/components/forms/login-form";
import { safeNextPath } from "@/lib/safe-next";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  // Only an invitation link is accepted as "come back to" (lib/safe-next.ts).
  const next = safeNextPath((await searchParams).next);
  return (
    <AuthCard title="Log in">
      <LoginForm next={next} />
      <Link href="/forgot-password" className="text-sm underline">Forgot your password?</Link>
      <p className="text-sm text-muted-foreground">
        New here? <Link href="/register" className="underline">Create an account</Link>
      </p>
    </AuthCard>
  );
}
