import type { ReactNode } from "react";

// Shown when the server refuses a page for the user's role.
export function NotAllowed(): ReactNode {
  return (
    <main className="flex max-w-xl flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">Not allowed</h1>
      <p className="text-muted-foreground">
        Your role does not allow this page. If you need it, ask the owner of the business.
      </p>
    </main>
  );
}
