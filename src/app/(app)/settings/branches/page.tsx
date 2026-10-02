import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AddBranchForm, BranchItem } from "@/components/forms/branch-forms";
import { NotAllowed } from "@/components/not-allowed";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { listBranches, type BranchDto } from "@/modules/tenants";
import { addBranchAction, renameBranchAction, toggleBranchAction } from "./actions";

export const metadata: Metadata = { title: "Branches" };

// Owner and Admin ("Business and tax settings"); listBranches checks it.
export default async function BranchesPage() {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  let branches: BranchDto[];
  try {
    branches = await listBranches(who.ctx);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    throw error;
  }
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Branches</h1>
      <p className="text-sm text-muted-foreground">
        Your shop locations. A closed branch keeps its history and can be reopened. Your plan sets how many can be open.
      </p>
      <ul className="flex flex-col divide-y rounded-lg border" aria-label="Branches">
        {branches.map((b) => (
          // Keyed by id and state, so a rename or close resets the row's form.
          <BranchItem key={`${b.id}-${b.name}-${String(b.open)}`} branch={b} rename={renameBranchAction} toggle={toggleBranchAction} />
        ))}
      </ul>
      <AddBranchForm action={addBranchAction} />
    </main>
  );
}
