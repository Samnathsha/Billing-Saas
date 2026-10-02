import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { AcceptInviteForm } from "@/components/forms/accept-invite-form";
import { AuthCard, FormMessage } from "@/components/forms/form-parts";
import { invitePath, safeNextPath } from "@/lib/safe-next";
import { getRequestContext } from "@/modules/auth";
import { acceptInviteAction } from "./actions";

export const metadata: Metadata = { title: "Invitation" };

// Where the invitation email's link lands.
export default async function InvitePage({ searchParams }: PageProps<"/invite">) {
  const { token } = await searchParams;
  const next = typeof token === "string" ? safeNextPath(invitePath(token)) : null;
  if (typeof token !== "string" || next === null) {
    return (
      <AuthCard title="This link is not complete">
        <FormMessage kind="error" text="Open the link from the invitation email again, or ask for a new invitation." />
      </AuthCard>
    );
  }

  const who = await getRequestContext(await headers());
  if (who.kind === "anonymous") {
    return (
      <AuthCard title="You are invited">
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
          <li>Log in with the email address this invitation was sent to.</li>
          <li>
            No account yet? Create one with that same email, confirm it from the email we send, then open the
            invitation link again.
          </li>
        </ol>
        <Link href={`/login?next=${encodeURIComponent(next)}`} className="underline">
          Log in to accept
        </Link>
        <Link href="/register" className="text-sm underline">
          Create an account
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Join the business">
      <p className="text-sm text-muted-foreground">You have been invited to join a business on Billing.</p>
      <AcceptInviteForm token={token} accept={acceptInviteAction} />
    </AuthCard>
  );
}
