"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { selectClass } from "@/components/forms/stock-forms";
import { readMeta, tillDb, type TillDb, type TillIdentity } from "@/lib/till/db";
import { rememberTill } from "@/lib/till/store";
import { refreshSnapshot } from "@/lib/till/sync";
import type { RegisteredTillDto } from "@/modules/sync";
import { useTillQuery } from "./till-hooks";

// Registering THIS computer as a till (decision 0006). The server answers
// with the till's token once; this browser keeps it in its till store and
// downloads the till's offline copy straight away.

const tillOf = async (db: TillDb): Promise<TillIdentity | null> => (await readMeta(db, "till")) ?? null;

export function RegisterThisComputer(props: {
  branches: { id: string; name: string }[];
  register: (input: { name: string; branchId: string; prefix: string }) => Promise<{ ok: true; till: RegisteredTillDto } | { ok: false; error: string }>;
}): ReactNode {
  const existing = useTillQuery(tillOf, null);
  const [name, setName] = useState("");
  const [branchId, setBranchId] = useState(props.branches[0]?.id ?? "");
  const [prefix, setPrefix] = useState("");
  const [message, setMessage] = useState<{ kind: "error" | "done"; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  if (existing !== null) {
    return (
      <p className="text-sm" role="status">
        This computer is the till <strong>{existing.name}</strong> ({existing.prefix}, {existing.branchName}).
        {existing.revoked ? (
          <>
            {" "}It was revoked: open <Link href="/sync" className="underline">Sync status</Link>.
          </>
        ) : (
          " It can bill without internet."
        )}
      </p>
    );
  }

  const submit = async (): Promise<void> => {
    setPending(true);
    setMessage(null);
    const result = await props.register({ name, branchId, prefix });
    if (!result.ok) {
      setMessage({ kind: "error", text: result.error });
      setPending(false);
      return;
    }
    const t = result.till;
    const db = tillDb();
    await rememberTill(db, { tillId: t.tillId, name: t.name, prefix: t.prefix, creditNotePrefix: `${t.prefix}R`, branchId: t.branchId, branchName: t.branchName, token: t.token });
    const copied = await refreshSnapshot(db, { fetch: (url, init) => fetch(url, init), now: Date.now, random: Math.random });
    setMessage({ kind: "done", text: copied === "done" ? `This computer is now the till ${t.name} (${t.prefix}). Open New bill once while online; then it can bill offline.` : `Registered as ${t.name}, but the shop's copy could not be downloaded yet. It will try again.` });
    setPending(false);
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border p-3"
      aria-label="Register this computer as a till"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className="font-medium">Register this computer as a till</h2>
      <p className="text-sm text-muted-foreground">Do this on the till computer itself. Its offline bills get their own number series, e.g. T1/26-27/00001 (returns T1R/…).</p>
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="till-name">Till name</Label>
          <Input id="till-name" value={name} onChange={(e) => { setName(e.target.value); }} maxLength={100} required className="w-48" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="till-branch">Branch</Label>
          <select id="till-branch" value={branchId} onChange={(e) => { setBranchId(e.target.value); }} className={selectClass}>
            {props.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="till-prefix">Bill prefix (1-3 letters or digits)</Label>
          <Input id="till-prefix" value={prefix} onChange={(e) => { setPrefix(e.target.value.toUpperCase()); }} maxLength={3} required className="w-24" />
        </div>
      </div>
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Registering…" : "Register this computer"}
      </Button>
      {message !== null ? (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "text-sm text-destructive" : "text-sm"}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
