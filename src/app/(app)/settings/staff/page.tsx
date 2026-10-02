import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { NotAllowed } from "@/components/not-allowed";
import { getRequestContext, PermissionDeniedError, requirePermission } from "@/modules/auth";

export const metadata: Metadata = { title: "Staff" };

// Owner/Admin only ("Manage users"). The server decides, whatever the menu
// shows. Staff management itself comes in Phase 4.
export default async function StaffPage() {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") redirect("/login");
  try {
    await requirePermission(who.ctx, "users.manage");
  } catch (error) {
    if (error instanceof PermissionDeniedError) return <NotAllowed />;
    throw error;
  }
  return (
    <main className="flex max-w-xl flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">Staff</h1>
      <p className="text-muted-foreground">Inviting staff and changing roles comes in the next phase.</p>
    </main>
  );
}
