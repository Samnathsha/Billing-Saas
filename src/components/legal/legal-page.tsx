import Link from "next/link";
import type { ReactNode } from "react";

// Layout for the draft legal pages (Phase 11): plain text rendered by React.
export function LegalPage({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-10 text-sm leading-relaxed [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc">
      <p role="note" className="rounded border border-amber-600 px-3 py-2 font-medium text-amber-800">
        DRAFT for review by a lawyer. Not in force yet. Text in [brackets] is to be filled in.
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
      <p className="mt-6 text-muted-foreground">
        <Link href="/terms" className="underline">Terms of Service</Link> · <Link href="/privacy" className="underline">Privacy Policy</Link> · <Link href="/login" className="underline">Log in</Link>
      </p>
    </main>
  );
}
