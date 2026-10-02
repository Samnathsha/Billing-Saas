import type { Metadata } from "next";

export const metadata: Metadata = { title: "Dashboard" };

// Placeholder until the dashboard phase.
export default function DashboardPage() {
  return (
    <main className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="text-muted-foreground">You are logged in. Sales, stock and reports come in later phases.</p>
    </main>
  );
}
