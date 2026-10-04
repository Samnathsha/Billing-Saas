import { SerwistProvider } from "@serwist/turbopack/react";
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
  // The service worker (decision 0006) runs only in a production build. It
  // must not reload the page when the internet returns (a sale may be open)
  // and must not cache every visited page.
  return (
    <SerwistProvider
      swUrl="/serwist/sw.js"
      disable={process.env.NODE_ENV !== "production"}
      cacheOnNavigation={false}
      reloadOnOnline={false}
    >
      <div className="flex min-h-full flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b px-4 py-3 print:hidden">
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/dashboard" className="font-semibold">Billing</Link>
            {/* Menu links follow the role for convenience only; each page checks on the server. */}
            {who.permissions.includes("sales.create") ? <Link href="/pos">New bill</Link> : null}
            <Link href="/sales">Bills</Link>
            <Link href="/customers">Customers</Link>
            <Link href="/catalog/products">Products</Link>
            <Link href="/inventory">Stock</Link>
            {who.permissions.includes("purchases.create") || who.permissions.includes("reports.view") ? <Link href="/purchases">Purchases</Link> : null}
            {who.permissions.includes("purchases.create") || who.permissions.includes("reports.view") ? <Link href="/suppliers">Suppliers</Link> : null}
            {who.permissions.includes("expenses.manage") || who.permissions.includes("reports.view") ? <Link href="/expenses">Expenses</Link> : null}
            {who.permissions.includes("reports.view") ? <Link href="/reports">Reports</Link> : null}
            {who.permissions.includes("settings.manage") ? <Link href="/settings/business">Business settings</Link> : null}
            {who.permissions.includes("settings.manage") ? <Link href="/settings/branches">Branches</Link> : null}
            {who.permissions.includes("users.manage") ? <Link href="/settings/staff">Staff</Link> : null}
            <Link href="/settings/devices">Your devices</Link>
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">{who.roleName}</span>
            <LogoutButton />
          </div>
        </header>
        <div className="flex flex-1 flex-col px-4 py-6 print:p-0">{children}</div>
      </div>
    </SerwistProvider>
  );
}
