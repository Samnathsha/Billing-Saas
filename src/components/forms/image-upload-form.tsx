"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "./form-parts";

export interface UploadState {
  error: string | null;
  info: string | null;
}

type Action = (p: UploadState, f: FormData) => Promise<UploadState>;

export function ImageUploadForm(props: { label: string; hidden?: Record<string, string>; action: Action }): ReactNode {
  const [state, action, pending] = useActionState(props.action, { error: null, info: null });
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" aria-label={props.label}>
      {Object.entries(props.hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input type="file" name="file" accept="image/png,image/jpeg,image/webp" required aria-label={props.label} className="text-sm" />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Uploading..." : "Upload"}
      </Button>
      <FormMessage kind={state.error === null ? "info" : "error"} text={state.error ?? state.info} />
    </form>
  );
}

export function RemoveImageButton(props: { fileId: string; hidden?: Record<string, string>; action: Action }): ReactNode {
  const [state, action, pending] = useActionState(props.action, { error: null, info: null });
  return (
    <form action={action}>
      <input type="hidden" name="fileId" value={props.fileId} />
      {Object.entries(props.hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        Remove
      </Button>
      <FormMessage kind="error" text={state.error} />
    </form>
  );
}
