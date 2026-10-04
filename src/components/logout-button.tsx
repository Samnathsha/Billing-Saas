"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { forgetOnLogout, outboxSummary } from "@/lib/till/store";
import { existingTillDb } from "@/components/till/till-hooks";

// Logging out. On a till with bills not yet sent, a warning comes first
// (blueprint 8.4): the bills stay on this computer and are sent when
// someone logs in here again. Logging out also ends offline billing for
// this person and removes the shop's copy, held bills and the till page
// kept by the browser (OWASP ASVS 8.2.3).
export function LogoutButton(): ReactNode {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [unsent, setUnsent] = useState<number | null>(null);

  async function logOut(): Promise<void> {
    setPending(true);
    const db = await existingTillDb();
    await authClient.signOut();
    if (db !== null) await forgetOnLogout(db);
    if (typeof caches !== "undefined") await caches.delete("till-pages");
    // Held (unsaved) bills belong to the person who held them.
    try {
      window.localStorage.removeItem("pos-held-carts");
    } catch {
      // Storage blocked: nothing was held.
    }
    router.replace("/login");
    router.refresh();
  }

  async function start(): Promise<void> {
    const db = await existingTillDb();
    const summary = db === null ? null : await outboxSummary(db);
    const waiting = summary === null ? 0 : summary.pending + summary.failed;
    if (waiting > 0) {
      setUnsent(waiting);
      return;
    }
    await logOut();
  }

  if (unsent !== null) {
    return (
      <div role="alertdialog" aria-label="Bills not sent yet" className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive p-2 text-sm">
        <span>
          {unsent} bill(s) or return(s) on this till are not sent yet. They stay here and are sent when someone logs in on this till. <Link href="/sync" className="underline">Sync status</Link>
        </span>
        <Button variant="outline" size="sm" onClick={() => { setUnsent(null); }}>
          Stay logged in
        </Button>
        <Button variant="destructive" size="sm" disabled={pending} onClick={() => void logOut()}>
          Log out anyway
        </Button>
      </div>
    );
  }
  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={() => void start()}>
      Log out
    </Button>
  );
}
