import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LogoutButton } from "@/components/logout-button";
import { getRequestContext } from "@/modules/auth";

// Every page inside the app needs a logged-in member of a business. The
// check runs on the server for every request; each page and service still
// checks its own permission.
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const who = await getRequestContext(await headers());
  if (who.kind === "anonymous") redirect("/login");
  if (who.kind === "no-business") redirect("/setup");
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <Link href="/dashboard" className="font-semibold">Billing</Link>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">{who.roleName}</span>
          <LogoutButton />
        </div>
      </header>
      <div className="flex flex-1 flex-col px-4 py-6">{children}</div>
    </div>
  );
}
