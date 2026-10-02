"use client";

import { useActionState, type ReactNode } from "react";
import type { StaffDto } from "@/modules/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface StaffFormState {
  error: string | null;
  info: string | null;
}

type Action = (previous: StaffFormState, form: FormData) => Promise<StaffFormState>;
type Role = StaffDto["roles"][number];

const EMPTY: StaffFormState = { error: null, info: null };

function Message({ state }: { state: StaffFormState }): ReactNode {
  if (state.error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {state.error}
      </p>
    );
  }
  if (state.info !== null) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {state.info}
      </p>
    );
  }
  return null;
}

function RoleSelect(props: { id: string; roles: Role[]; defaultValue?: string; label: string }): ReactNode {
  return (
    <select
      id={props.id}
      name="roleId"
      defaultValue={props.defaultValue ?? ""}
      required
      aria-label={props.label}
      className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
    >
      {props.defaultValue === undefined ? <option value="">Choose a role</option> : null}
      {props.roles.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </select>
  );
}

export function InviteForm({ action, roles }: { action: Action; roles: Role[] }): ReactNode {
  const [state, formAction, pending] = useActionState(action, EMPTY);
  return (
    <form action={formAction} className="flex flex-col gap-2" aria-label="Invite staff">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="invite-email">Email</Label>
          <Input id="invite-email" name="email" type="email" maxLength={254} required className="w-64" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="invite-role">Role</Label>
          <RoleSelect id="invite-role" roles={roles} label="Role" />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Sending..." : "Send invitation"}
        </Button>
      </div>
      <Message state={state} />
    </form>
  );
}

// One person. The Owner and yourself cannot be changed here (business
// rules section 10); the server refuses it anyway.
export function MemberItem(props: {
  member: StaffDto["members"][number];
  roles: Role[];
  changeRole: Action;
  deactivate: Action;
}): ReactNode {
  const { member } = props;
  const [roleState, roleAction, changing] = useActionState(props.changeRole, EMPTY);
  const [offState, offAction, deactivating] = useActionState(props.deactivate, EMPTY);
  const locked = member.isOwner || member.isYou || !member.active;
  return (
    <li className="flex flex-col gap-2 p-3" aria-label={member.name}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col text-sm">
          <span className="font-medium">
            {member.name}
            {member.isYou ? " (you)" : ""}
          </span>
          <span className="text-muted-foreground">{member.email}</span>
        </div>
        {locked ? (
          <span className="text-sm text-muted-foreground">
            {member.roleName}
            {member.active ? "" : " · deactivated"}
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <form action={roleAction} className="flex items-center gap-2">
              <input type="hidden" name="userId" value={member.userId} />
              <RoleSelect id={`role-${member.userId}`} roles={props.roles} defaultValue={member.roleId} label={`Role of ${member.name}`} />
              <Button type="submit" variant="outline" size="sm" disabled={changing}>
                Change role
              </Button>
            </form>
            <form action={offAction}>
              <input type="hidden" name="userId" value={member.userId} />
              <Button type="submit" variant="destructive" size="sm" disabled={deactivating}>
                Deactivate
              </Button>
            </form>
          </div>
        )}
      </div>
      <Message state={roleState.error !== null || roleState.info !== null ? roleState : offState} />
    </li>
  );
}

export function InvitationItem(props: { invitation: StaffDto["invitations"][number]; revoke: Action }): ReactNode {
  const { invitation } = props;
  const [state, action, pending] = useActionState(props.revoke, EMPTY);
  const until = new Date(invitation.expiresAt).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
  return (
    <li className="flex flex-col gap-2 p-3" aria-label={invitation.email}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          <span className="font-medium">{invitation.email}</span> · {invitation.roleName} ·{" "}
          <span className="text-muted-foreground">{invitation.expired ? "expired" : `valid until ${until}`}</span>
        </span>
        <form action={action}>
          <input type="hidden" name="invitationId" value={invitation.id} />
          <Button type="submit" variant="outline" size="sm" disabled={pending}>
            Withdraw
          </Button>
        </form>
      </div>
      <Message state={state} />
    </li>
  );
}
