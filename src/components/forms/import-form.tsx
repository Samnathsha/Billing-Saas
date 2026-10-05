"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "./form-parts";

export interface ImportState {
  message: string | null;
  errors: { row: number; column: string; message: string }[];
  done: boolean;
}

export function ImportForm({ action }: { action: (p: ImportState, f: FormData) => Promise<ImportState> }): ReactNode {
  const [state, formAction, pending] = useActionState(action, { message: null, errors: [], done: false });
  return (
    <form action={formAction} className="flex flex-col gap-4" aria-label="Import products">
      <input type="file" name="file" accept=".csv,text/csv" required aria-label="CSV file" className="text-sm" />
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Checking and importing..." : "Import"}
      </Button>
      <FormMessage kind={state.done ? "info" : "error"} text={state.message} />
      {state.errors.length > 0 ? (
        <div className="table-scroll"><table className="w-full max-w-3xl text-left text-sm" aria-label="Problems">
          <thead>
            <tr>
              <th className="p-1">Line</th>
              <th className="p-1">Column</th>
              <th className="p-1">Problem</th>
            </tr>
          </thead>
          <tbody>
            {state.errors.map((e, i) => (
              <tr key={i} className="border-t">
                <td className="p-1">{e.row}</td>
                <td className="p-1">{e.column}</td>
                <td className="p-1">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : null}
    </form>
  );
}
