import { SerwistProvider } from "@serwist/turbopack/react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppNav, type NavGroup } from "@/components/app-nav";
import { LogoutButton } from "@/components/logout-button";
import { TillEngine } from "@/components/till/till-engine";
import { getRequestContext } from "@/modules/auth";
import { getBusinessDeletion } from "@/modules/tenants";
import { DeletionBanner } from "@/components/forms/business-data-forms";

// Every page inside the app needs a logged-in member of a business. The
// check runs on the server for every request; each page and service still
// checks its own permission.
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const who = await getRequestContext(await headers());
  if (who.kind === "anonymous") redirect("/login");
  if (who.kind === "no-business") redirect("/setup");
  const deletion = await getBusinessDeletion(who.ctx).catch(() => null);
  const can = (...permissions: string[]): boolean => permissions.some((p) => who.permissions.includes(p));
  // Menu links follow the role for convenience only; each page checks on
  // the server.
  const menu: NavGroup[] = [
    {
      title: "Sell",
      links: [
        { href: "/dashboard", label: "Dashboard" },
        ...(can("sales.create") ? [{ href: "/pos", label: "New bill" }] : []),
        { href: "/sales", label: "Bills" },
        { href: "/customers", label: "Customers" },
      ],
    },
    {
      title: "Stock",
      links: [
        { href: "/catalog/products", label: "Products" },
        { href: "/inventory", label: "Stock" },
        ...(can("purchases.create", "reports.view") ? [{ href: "/purchases", label: "Purchases" }, { href: "/suppliers", label: "Suppliers" }] : []),
      ],
    },
    {
      title: "Money",
      links: [
        ...(can("expenses.manage", "reports.view") ? [{ href: "/expenses", label: "Expenses" }] : []),
        ...(can("reports.view") ? [{ href: "/reports", label: "Reports" }] : []),
      ],
    },
    {
      title: "Settings",
      links: [
        ...(can("settings.manage") ? [{ href: "/settings/business", label: "Business settings" }, { href: "/settings/branches", label: "Branches" }] : []),
        ...(can("users.manage") ? [{ href: "/settings/staff", label: "Staff" }] : []),
        ...(can("tills.manage") ? [{ href: "/settings/tills", label: "Tills" }] : []),
        { href: "/settings/devices", label: "Your devices" },
        { href: "/settings/security", label: "Two-step login" },
      ],
    },
  ].filter((g) => g.links.length > 0);
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
      <div className="flex min-h-full flex-1 flex-col bg-muted/40 lg:flex-row">
        <AppNav groups={menu} roleName={who.roleName} footer={<LogoutButton />} />
        <div className="flex min-w-0 flex-1 flex-col">
          {deletion?.dueAt ? <DeletionBanner dueAt={deletion.dueAt} /> : null}
          <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8 lg:py-8 print:max-w-none print:p-0">{children}</div>
        </div>
        {/* Sends a registered till's offline bills whenever it is online. */}
        <TillEngine />
      </div>
    </SerwistProvider>
  );
}
