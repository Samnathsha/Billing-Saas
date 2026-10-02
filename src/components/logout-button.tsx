"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export function LogoutButton(): ReactNode {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function logOut(): Promise<void> {
    setPending(true);
    await authClient.signOut();
    router.replace("/login");
    router.refresh();
  }
  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={() => void logOut()}>
      Log out
    </Button>
  );
}
