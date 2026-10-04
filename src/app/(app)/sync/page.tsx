import type { Metadata } from "next";
import { SyncStatus } from "@/components/till/sync-status";

export const metadata: Metadata = { title: "Sync status" };

// This till's sync status (decision 0006; blueprint 8.4). Everything shown
// comes from this computer's own till store, so the page also works
// offline (the service worker keeps it).
export default function SyncPage() {
  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Sync status</h1>
      <SyncStatus />
    </main>
  );
}
