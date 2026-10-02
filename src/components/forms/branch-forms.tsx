"use client";

import { useActionState, type ReactNode } from "react";
import type { BranchDto } from "@/modules/tenants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface BranchFormState {
  error: string | null;
}

type Action = (previous: BranchFormState, form: FormData) => Promise<BranchFormState>;

function ErrorText({ text }: { text: string | null }): ReactNode {
  return text === null ? null : (
    <p role="alert" className="text-sm text-destructive">
      {text}
    </p>
  );
}

export function AddBranchForm({ action }: { action: Action }): ReactNode {
  const [state, formAction, pending] = useActionState(action, { error: null });
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Label htmlFor="new-branch">New branch name</Label>
      <div className="flex gap-2">
        <Input id="new-branch" name="name" maxLength={100} required className="max-w-xs" />
        <Button type="submit" disabled={pending}>
          Add branch
        </Button>
      </div>
      <ErrorText text={state.error} />
    </form>
  );
}

// One branch: rename, and close or reopen.
export function BranchItem(props: { branch: BranchDto; rename: Action; toggle: Action }): ReactNode {
  const { branch } = props;
  const [renameState, renameAction, renaming] = useActionState(props.rename, { error: null });
  const [toggleState, toggleAction, toggling] = useActionState(props.toggle, { error: null });
  const inputId = `branch-${branch.id}`;
  return (
    <li className="flex flex-col gap-2 p-3" aria-label={branch.name}>
      <div className="flex flex-wrap items-end gap-2">
        <form action={renameAction} className="flex items-end gap-2">
          <input type="hidden" name="branchId" value={branch.id} />
          <div className="flex flex-col gap-1">
            <Label htmlFor={inputId} className="text-xs text-muted-foreground">
              {branch.open ? "Open" : "Closed"}
            </Label>
            <Input id={inputId} name="name" defaultValue={branch.name} maxLength={100} required aria-label={`Name of ${branch.name}`} />
          </div>
          <Button type="submit" variant="outline" size="sm" disabled={renaming}>
            Rename
          </Button>
        </form>
        <form action={toggleAction}>
          <input type="hidden" name="branchId" value={branch.id} />
          <input type="hidden" name="open" value={branch.open ? "yes" : "no"} />
          <Button type="submit" variant={branch.open ? "destructive" : "outline"} size="sm" disabled={toggling}>
            {branch.open ? "Close branch" : "Reopen"}
          </Button>
        </form>
      </div>
      <ErrorText text={renameState.error ?? toggleState.error} />
    </li>
  );
}
