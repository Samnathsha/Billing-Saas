import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/modules/auth";

// The front door: sends each visitor where they belong.
export default async function Home() {
  const who = await getRequestContext(await headers());
  if (who.kind === "anonymous") redirect("/login");
  if (who.kind === "no-business") redirect("/setup");
  redirect("/dashboard");
}
