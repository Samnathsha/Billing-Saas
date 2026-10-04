"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EMPTY, Result, type FormAction } from "./stock-forms";

export function RevokeTillForm(props: { tillId: string; name: string; revoke: FormAction }): ReactNode {
  const [state, action, pending] = useActionState(props.revoke, EMPTY);
  return (
    <form action={action} className="flex items-center gap-2" aria-label={["Revoke", props.name].join(" ")}>
      <input type="hidden" name="tillId" value={props.tillId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        Revoke
      </Button>
      <Result state={state} />
    </form>
  );
}

export function OfflineWindowForm(props: { hours: number; save: FormAction }): ReactNode {
  const [state, action, pending] = useActionState(props.save, EMPTY);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" aria-label="Offline window">
      <div className="flex flex-col gap-1">
        <Label htmlFor="offline-hours">Tills may bill offline for (hours after their last online contact)</Label>
        <Input id="offline-hours" name="hours" defaultValue={String(props.hours)} inputMode="numeric" maxLength={3} className="w-24" required />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        Save
      </Button>
      <Result state={state} />
    </form>
  );
}

export function ResolveFlagForm(props: { flagId: string; resolve: FormAction }): ReactNode {
  const [state, action, pending] = useActionState(props.resolve, EMPTY);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" aria-label="Mark as reviewed">
      <input type="hidden" name="flagId" value={props.flagId} />
      <Input name="note" aria-label="What was done" placeholder="What was done" maxLength={500} required className="h-7 w-56" />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        Reviewed
      </Button>
      <Result state={state} />
    </form>
  );
}
