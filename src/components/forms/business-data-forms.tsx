"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EMPTY, Result, type ActionState } from "./stock-forms";

// The owner's own data (Phase 11): export everything; ask for the business
// to be deleted (30 days' grace) or cancel that.

const when = (iso: string): string => new Date(iso).toLocaleDateString("en-IN", { dateStyle: "long", timeZone: "Asia/Kolkata" });

export function BusinessDataSection(props: {
  businessName: string;
  dueAt: string | null;
  graceDays: number;
  request: (previous: ActionState, form: FormData) => Promise<ActionState>;
  cancel: (previous: ActionState) => Promise<ActionState>;
}): ReactNode {
  const [requestState, requestAction, requesting] = useActionState(props.request, EMPTY);
  const [cancelState, cancelAction, cancelling] = useActionState(props.cancel, EMPTY);
  return (
    <section aria-label="Your business's data" className="flex max-w-xl flex-col gap-3 rounded-lg border p-4">
      <h2 className="font-semibold">Your business&apos;s data</h2>
      <p className="text-sm">Download every record (bills, stock, customers, staff, logs) as spreadsheet files in one ZIP. Keep it safe: it holds your customers&apos; details.</p>
      <a href="/api/business/export" download className="self-start rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-muted">
        Download all data (ZIP)
      </a>
      {props.dueAt === null ? (
        <form action={requestAction} className="flex flex-col gap-2 border-t pt-3" aria-label="Delete this business">
          <h3 className="font-medium text-destructive">Delete this business</h3>
          <p className="text-sm">
            Everything is deleted {props.graceDays} days after you ask: bills, stock, customers, staff and logs. Until then everything works and you can cancel. GST law usually requires keeping bills for several years: download the data first and ask your accountant.
          </p>
          <Label htmlFor="confirmName">Type the business name ({props.businessName}) to confirm</Label>
          <Input id="confirmName" name="confirmName" autoComplete="off" maxLength={200} required />
          <Button type="submit" variant="destructive" disabled={requesting} className="self-start">
            Ask to delete this business
          </Button>
          <Result state={requestState} />
        </form>
      ) : (
        <form action={cancelAction} className="flex flex-col gap-2 border-t pt-3" aria-label="Cancel deletion">
          <p className="text-sm font-medium text-destructive" role="status">
            This business will be deleted on {when(props.dueAt)}.
          </p>
          <Button type="submit" variant="outline" disabled={cancelling} className="self-start">
            Cancel the deletion
          </Button>
          <Result state={cancelState} />
        </form>
      )}
    </section>
  );
}

export function DeletionBanner({ dueAt }: { dueAt: string }): ReactNode {
  return (
    <p className="border-b border-destructive bg-destructive/10 px-4 py-2 text-sm text-destructive print:hidden" role="alert">
      This business will be deleted on {when(dueAt)}. Until then everything works; the owner can cancel it in Business settings.
    </p>
  );
}
