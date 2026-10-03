import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Private file storage. Development and tests: a local folder outside the
// web root (.local-files/, git-ignored), standing in for Cloudflare R2.
// Production will use R2 through the same two functions (owner creates the
// account; keys only in .env.local / the host's settings).
const ROOT = resolve(process.cwd(), ".local-files");

// Keys are "<businessId>/<randomId>.webp" (checked by the database too), so
// no path can escape the folder.
const KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.webp$/;

function pathOf(key: string): string {
  if (!KEY.test(key)) throw new Error("file store: bad key");
  return join(ROOT, key);
}

export async function putFile(key: string, bytes: Buffer): Promise<void> {
  const path = pathOf(key);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
}

export async function getFile(key: string): Promise<Buffer> {
  return readFile(pathOf(key));
}
