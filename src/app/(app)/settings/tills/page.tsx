import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NotAllowed } from "@/components/not-allowed";
import { OfflineWindowForm, RevokeTillForm } from "@/components/forms/till-forms";
import { RegisterThisComputer } from "@/components/till/register-till";
import { getRequestContext } from "@/modules/auth";
import { countOpenSyncFlags, getOfflineWindowHours, listTills } from "@/modules/sync";
import { listBranchChoices } from "@/modules/tenants";
import { offlineWindowAction, registerTillAction, revokeTillAction } from "./actions";

export const metadata: Metadata = { title: "Tills" };

const when = (iso: string | null): string => (iso === null ? "never" : new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }));

// Registered tills (decision 0006): "Manage tills" (Owner, Admin, Manager).
export default async function TillsPage() {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  if (!who.permissions.includes("tills.manage")) return <NotAllowed />;
  const [tills, branches, hours, openFlags] = await Promise.all([listTills(who.ctx), listBranchChoices(who.ctx), getOfflineWindowHours(who.ctx), countOpenSyncFlags(who.ctx)]);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Tills</h1>
        <Link href="/settings/tills/flags" className="text-sm underline">
          Offline bills to check ({openFlags})
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        A registered till can keep billing when the internet stops. Its offline bills are sent when the connection is back; anything that no longer fits (price, stock, IMEI…) is kept and listed for you to check.
      </p>
      <RegisterThisComputer branches={branches.filter((b) => b.open).map((b) => ({ id: b.id, name: b.name }))} register={registerTillAction} />
      <section aria-label="Registered tills" className="flex flex-col gap-2">
        <h2 className="font-medium">Registered tills</h2>
        {tills.length === 0 ? <p className="text-sm text-muted-foreground">No tills yet.</p> : null}
        <ul className="flex flex-col divide-y rounded-lg border">
          {tills.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm" aria-label={t.name}>
              <span>
                <strong>{t.name}</strong> ({t.prefix}) · {t.branchName} · {t.status === "revoked" ? `revoked ${when(t.revokedAt)}` : `last seen ${when(t.lastSeenAt)}`}
              </span>
              {t.status === "active" ? <RevokeTillForm tillId={t.id} name={t.name} revoke={revokeTillAction} /> : null}
            </li>
          ))}
        </ul>
      </section>
      {who.permissions.includes("settings.manage") ? <OfflineWindowForm hours={hours} save={offlineWindowAction} /> : <p className="text-sm">Tills may bill offline for {hours} hours after their last online contact.</p>}
    </main>
  );
}
