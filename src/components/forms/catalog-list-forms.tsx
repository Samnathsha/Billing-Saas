"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ListFormState {
  error: string | null;
}

type Action = (previous: ListFormState, form: FormData) => Promise<ListFormState>;
type Kind = "category" | "brand" | "unit";

function ErrorText({ text }: { text: string | null }): ReactNode {
  return text === null ? null : (
    <p role="alert" className="text-sm text-destructive">
      {text}
    </p>
  );
}

// "Add" form: a name, plus extra fields per kind.
export function AddListItemForm(props: {
  kind: Kind;
  action: Action;
  parents?: { id: string; name: string }[];
}): ReactNode {
  const [state, formAction, pending] = useActionState(props.action, { error: null });
  const id = `new-${props.kind}`;
  return (
    <form action={formAction} className="flex flex-col gap-2" aria-label={`Add ${props.kind}`}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={id}>Name</Label>
          <Input id={id} name="name" maxLength={100} required className="w-48" />
        </div>
        {props.kind === "category" ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-parent`}>Inside (optional)</Label>
            <select id={`${id}-parent`} name="parentId" defaultValue="" className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm">
              <option value="">— main category —</option>
              {(props.parents ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {props.kind === "unit" ? (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-code`}>Code</Label>
              <Input id={`${id}-code`} name="code" maxLength={10} required className="w-24" />
            </div>
            <Label className="font-normal">
              <input type="checkbox" name="allowsFraction" />
              Fractions allowed (e.g. 1.5 m)
            </Label>
          </>
        ) : null}
        <Button type="submit" disabled={pending}>
          Add
        </Button>
      </div>
      <ErrorText text={state.error} />
    </form>
  );
}

// One item: rename, archive or restore.
export function ListItem(props: {
  kind: Kind;
  item: { id: string; name: string; active: boolean };
  detail?: string;
  rename: Action;
  archive: Action;
}): ReactNode {
  const { item } = props;
  const [renameState, renameAction, renaming] = useActionState(props.rename, { error: null });
  const [archiveState, archiveAction, archiving] = useActionState(props.archive, { error: null });
  return (
    <li className="flex flex-col gap-1 p-2" aria-label={item.name}>
      <div className="flex flex-wrap items-center gap-2">
        <form action={renameAction} className="flex items-center gap-2">
          <input type="hidden" name="kind" value={props.kind} />
          <input type="hidden" name="id" value={item.id} />
          <Input name="name" defaultValue={item.name} maxLength={100} required aria-label={`Name of ${item.name}`} className="w-48" />
          <Button type="submit" variant="outline" size="sm" disabled={renaming}>
            Rename
          </Button>
        </form>
        <form action={archiveAction}>
          <input type="hidden" name="kind" value={props.kind} />
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="archived" value={item.active ? "yes" : "no"} />
          <Button type="submit" variant="outline" size="sm" disabled={archiving}>
            {item.active ? "Archive" : "Restore"}
          </Button>
        </form>
        <span className="text-xs text-muted-foreground">
          {props.detail ?? ""}
          {item.active ? "" : " (archived)"}
        </span>
      </div>
      <ErrorText text={renameState.error ?? archiveState.error} />
    </li>
  );
}
