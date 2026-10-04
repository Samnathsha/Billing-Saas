import { randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import type { Page } from "@playwright/test";
import pg from "pg";
import { PASSWORD } from "../flows/helpers";
import { LOCAL_AUTH_DB_URL } from "../flows/local-db";

// A production server sends real email only, so these tests cannot confirm
// an address by email. Instead the confirmed login is written straight into
// the LOCAL throwaway database through the login role, with the same
// password hashing as the app (src/modules/auth/better-auth.ts). Logging in
// then goes through the real login page.
// The app's Argon2id settings (OWASP baseline).
const ARGON2ID = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export async function confirmedAccountInDb(_page: Page, label = "offline"): Promise<string> {
  const email = `${label}-${randomUUID()}@test.invalid`;
  const password = await hash(PASSWORD, ARGON2ID);
  const client = new pg.Client({ connectionString: LOCAL_AUTH_DB_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO users (email, display_name, email_verified) VALUES ($1, 'Offline Person', true) RETURNING id",
      [email],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("user not created");
    await client.query("INSERT INTO accounts (account_id, provider_id, user_id, password) VALUES ($1::text, 'credential', $1::uuid, $2)", [id, password]);
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
  return email;
}
