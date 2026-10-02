import type { Metadata } from "next";
import { headers } from "next/headers";
import { Button } from "@/components/ui/button";
import { listMySessions } from "@/modules/auth";
import { endSessionAction, logOutEverywhereAction } from "./actions";

export const metadata: Metadata = { title: "Your devices" };

const when = (iso: string): string =>
  new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

// Every page here is behind the app frame's login check; the list holds only
// the logged-in user's own sessions, never tokens.
export default async function DevicesPage() {
  const sessions = await listMySessions(await headers());
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Your devices</h1>
      <p className="text-sm text-muted-foreground">
        Where you are logged in now. End any device you do not recognise, then change your password.
      </p>
      <ul className="flex flex-col divide-y rounded-lg border" aria-label="Logged-in devices">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-4 p-3">
            <div className="flex min-w-0 flex-col text-sm">
              <span className="truncate font-medium">
                {s.current ? "This device" : "Another device"}
                {s.device === null ? "" : ` · ${s.device}`}
              </span>
              <span className="text-muted-foreground">
                Logged in {when(s.signedInAt)} · last used {when(s.lastActiveAt)}
                {s.ipAddress === null ? "" : ` · ${s.ipAddress}`}
              </span>
            </div>
            <form action={endSessionAction}>
              <input type="hidden" name="sessionId" value={s.id} />
              <input type="hidden" name="current" value={s.current ? "yes" : "no"} />
              <Button type="submit" variant="outline" size="sm">
                {s.current ? "Log out" : "End"}
              </Button>
            </form>
          </li>
        ))}
      </ul>
      <form action={logOutEverywhereAction}>
        <Button type="submit" variant="destructive">Log out everywhere</Button>
      </form>
    </main>
  );
}
