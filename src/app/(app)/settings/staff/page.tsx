import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { InvitationItem, InviteForm, MemberItem } from "@/components/forms/staff-forms";
import { NotAllowed } from "@/components/not-allowed";
import { getRequestContext, listStaff, PermissionDeniedError, type StaffDto } from "@/modules/auth";
import { changeRoleAction, deactivateAction, inviteAction, revokeAction } from "./actions";

export const metadata: Metadata = { title: "Staff" };

// Owner and Admin ("Manage users"); listStaff checks it on the server.
export default async function StaffPage() {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  let staff: StaffDto;
  try {
    staff = await listStaff(who.ctx);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    throw error;
  }
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Staff</h1>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Invite someone</h2>
        <p className="text-sm text-muted-foreground">
          They get an email with a link that works once, for 7 days. They log in, or create an account, with that same
          email address to join.
        </p>
        <InviteForm action={inviteAction} roles={staff.roles} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Team</h2>
        <ul className="flex flex-col divide-y rounded-lg border" aria-label="Team">
          {staff.members.map((m) => (
            // Keyed by person only, so the row's message survives the refresh
            // after a change.
            <MemberItem
              key={m.userId}
              member={m}
              roles={staff.roles}
              changeRole={changeRoleAction}
              deactivate={deactivateAction}
            />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Open invitations</h2>
        {staff.invitations.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border" aria-label="Open invitations">
            {staff.invitations.map((i) => (
              <InvitationItem key={i.id} invitation={i} revoke={revokeAction} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
