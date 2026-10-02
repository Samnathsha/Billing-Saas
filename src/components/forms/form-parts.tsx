import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Small shared pieces for the login screens.

export function Field(props: {
  id: string;
  label: string;
  type: "text" | "email" | "password";
  autoComplete: string;
  minLength?: number;
  maxLength?: number;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        name={props.id}
        type={props.type}
        autoComplete={props.autoComplete}
        required
        minLength={props.minLength}
        maxLength={props.maxLength}
      />
    </div>
  );
}

// Messages are plain text rendered by React (never as HTML).
export function FormMessage({ kind, text }: { kind: "error" | "info"; text: string | null }): ReactNode {
  if (text === null) return null;
  return (
    <p
      role={kind === "error" ? "alert" : "status"}
      className={kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
    >
      {text}
    </p>
  );
}

export function AuthCard({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </main>
  );
}

export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
