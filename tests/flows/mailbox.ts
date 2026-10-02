import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";

// Reads the newest link sent to an address from .dev-mailbox/ (the dev
// server's mailbox when no email service is set).
const DIR = join(process.cwd(), ".dev-mailbox");

export async function lastLinkTo(address: string, contains: string): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(() => {
      const files = readdirSync(DIR).sort().reverse();
      for (const file of files) {
        const text = readFileSync(join(DIR, file), "utf8");
        if (!text.startsWith(`To: ${address}\n`)) continue;
        link = text.match(/https?:\/\/\S+/)?.[0];
        if (link?.includes(contains) === true) return true;
      }
      return false;
    }, { timeout: 15_000 })
    .toBe(true);
  return link ?? "";
}
