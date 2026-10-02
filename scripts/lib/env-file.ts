// Pure helpers for scripts/set-db-passwords.ts, kept separate so they can be
// unit-tested without a database or a real .env.local.

export type RoleName = "app_user" | "migrator" | "auth_service";

function isNeon(url: URL): boolean {
  return url.hostname.endsWith(".neon.tech");
}

// Neon: the pooled host has "-pooler" after the endpoint id. Neon URLs get
// sslmode=verify-full (encrypted, and the server's certificate is checked).
export function connectionUrl(base: string, user: RoleName, password: string, pooled: boolean): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  if (isNeon(url)) {
    const [endpoint = "", ...rest] = url.hostname.split(".");
    const direct = endpoint.replace(/-pooler$/, "");
    url.hostname = [pooled ? `${direct}-pooler` : direct, ...rest].join(".");
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

export function withStrictSsl(connectionString: string): string {
  const url = new URL(connectionString);
  if (isNeon(url)) url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

export function valueOf(lines: readonly string[], key: string): string | undefined {
  const line = lines.find((l) => l.startsWith(`${key}=`));
  if (line === undefined) return undefined;
  const value = line.slice(key.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  return value === "" ? undefined : value;
}

// Replaces or appends KEY=value lines and drops the `remove` keys. Every other
// line (comments, unrelated settings) is kept as it was.
export function updateEnvLines(
  lines: readonly string[],
  updates: Readonly<Record<string, string>>,
  remove: readonly string[],
): string {
  const pending = new Map(Object.entries(updates));
  const out = lines
    .filter((line) => !remove.some((key) => line.startsWith(`${key}=`)))
    .map((line) => {
      const key = line.split("=", 1)[0] ?? "";
      const value = pending.get(key);
      if (value === undefined) return line;
      pending.delete(key);
      return `${key}=${value}`;
    });
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  return `${out.join("\n")}\n`;
}
