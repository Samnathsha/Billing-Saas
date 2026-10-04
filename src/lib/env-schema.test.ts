import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "./env-schema";

const DEV = "postgres://app_user@localhost:5432/billing_dev";
const AUTH_DEV = "postgres://auth_service@localhost:5432/billing_dev";
const TEST = "postgresql://app_user@localhost:5432/billing_test";
const AUTH_TEST = "postgresql://auth_service@localhost:5432/billing_test";
const SECRET = "0123456789abcdef0123456789abcdef-made-up";
const URL_ = "http://localhost:3000";

const shared = { BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: URL_ };
const RESEND = { RESEND_API_KEY: "re_made_up_test_key_42", EMAIL_FROM: "Shop <noreply@example.com>" };
const devEnv = { NODE_ENV: "development", DATABASE_URL_DEV: DEV, AUTH_DATABASE_URL_DEV: AUTH_DEV, ...shared };
const testEnv = { NODE_ENV: "test", DATABASE_URL_TEST: TEST, AUTH_DATABASE_URL_TEST: AUTH_TEST, ...shared };

function problemsOf(source: Record<string, string | undefined>): string[] {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvError) return error.problems;
    throw error;
  }
  throw new Error("expected parseEnv to throw");
}

describe("parseEnv: valid settings", () => {
  it("development uses the _DEV databases", () => {
    expect(parseEnv(devEnv)).toEqual({
      mode: "development",
      databaseUrl: DEV,
      authDatabaseUrl: AUTH_DEV,
      authSecret: SECRET,
      authUrl: URL_,
      email: null,
      healthDrill: false,
    });
  });

  it("development with Resend settings sends real email", () => {
    expect(parseEnv({ ...devEnv, ...RESEND }).email).toEqual({ resendApiKey: RESEND.RESEND_API_KEY, from: RESEND.EMAIL_FROM });
  });

  it("empty optional settings count as not set (development without email)", () => {
    expect(parseEnv({ ...devEnv, RESEND_API_KEY: "", EMAIL_FROM: "" }).email).toBeNull();
    expect(parseEnv({ ...devEnv, DATABASE_URL_TEST: "" }).databaseUrl).toBe(DEV);
  });

  it("tests never send real email, even if Resend settings are present", () => {
    expect(parseEnv({ ...testEnv, ...RESEND }).email).toBeNull();
  });

  it("production requires Resend settings", () => {
    expect(parseEnv({ ...devEnv, ...RESEND, NODE_ENV: "production" }).email).not.toBeNull();
    expect(problemsOf({ ...devEnv, NODE_ENV: "production" })).toEqual(["RESEND_API_KEY is missing", "EMAIL_FROM is missing"]);
  });

  it("missing NODE_ENV means development", () => {
    expect(parseEnv({ ...devEnv, NODE_ENV: undefined }).mode).toBe("development");
  });

  it("test uses the _TEST databases", () => {
    const env = parseEnv({ ...testEnv, DATABASE_URL_DEV: DEV });
    expect(env.databaseUrl).toBe(TEST);
    expect(env.authDatabaseUrl).toBe(AUTH_TEST);
  });

  it("a local production build uses the _DEV databases for now", () => {
    expect(parseEnv({ ...devEnv, ...RESEND, NODE_ENV: "production" }).databaseUrl).toBe(DEV);
  });

  it("ignores unrelated variables", () => {
    expect(parseEnv({ ...devEnv, PATH: "/usr/bin", HOME: "/Users/x" }).databaseUrl).toBe(DEV);
  });
});

describe("parseEnv: stops on bad settings", () => {
  it("development without DATABASE_URL_DEV", () => {
    expect(problemsOf({ ...devEnv, DATABASE_URL_DEV: undefined })).toEqual(["DATABASE_URL_DEV is missing"]);
  });

  it("an empty value counts as missing", () => {
    expect(problemsOf({ ...devEnv, DATABASE_URL_DEV: "" })).toEqual(["DATABASE_URL_DEV is missing"]);
  });

  it("test without DATABASE_URL_TEST, even if DEV is set", () => {
    expect(problemsOf({ ...testEnv, DATABASE_URL_TEST: undefined, DATABASE_URL_DEV: DEV })).toEqual([
      "DATABASE_URL_TEST is missing",
    ]);
  });

  it("the login database connection is required", () => {
    expect(problemsOf({ ...devEnv, AUTH_DATABASE_URL_DEV: undefined })).toEqual(["AUTH_DATABASE_URL_DEV is missing"]);
    expect(problemsOf({ ...testEnv, AUTH_DATABASE_URL_TEST: "" })).toEqual(["AUTH_DATABASE_URL_TEST is missing"]);
  });

  it("the app and the login library must use different roles", () => {
    expect(problemsOf({ ...devEnv, AUTH_DATABASE_URL_DEV: DEV })).toEqual([
      "DATABASE_URL_DEV and AUTH_DATABASE_URL_DEV must use different roles",
    ]);
  });

  it.each(["https://localhost/billing", "mysql://localhost/billing", "not a url", "localhost:5432"])(
    "rejects a non-Postgres value: %s",
    (value) => {
      expect(problemsOf({ ...devEnv, DATABASE_URL_DEV: value })).toEqual([
        "DATABASE_URL_DEV must be a postgres:// or postgresql:// connection string",
      ]);
    },
  );

  it("rejects a bad optional URL too", () => {
    expect(problemsOf({ ...devEnv, DATABASE_URL_TEST: "nope" })).toEqual([
      "DATABASE_URL_TEST must be a postgres:// or postgresql:// connection string",
    ]);
  });

  it("dev and test must be different databases", () => {
    expect(problemsOf({ ...testEnv, DATABASE_URL_DEV: TEST })).toEqual([
      "DATABASE_URL_DEV and DATABASE_URL_TEST must point to different databases",
    ]);
  });

  it("the auth secret is required and must be long", () => {
    expect(problemsOf({ ...devEnv, BETTER_AUTH_SECRET: undefined })).toEqual(["BETTER_AUTH_SECRET is missing"]);
    expect(problemsOf({ ...devEnv, BETTER_AUTH_SECRET: "short" })).toEqual([
      "BETTER_AUTH_SECRET must be at least 32 characters (run: npm run auth:secret)",
    ]);
  });

  it("the app address must be http or https", () => {
    expect(problemsOf({ ...devEnv, BETTER_AUTH_URL: undefined })).toEqual(["BETTER_AUTH_URL is missing"]);
    expect(problemsOf({ ...devEnv, BETTER_AUTH_URL: "ftp://x" })).toEqual([
      "BETTER_AUTH_URL must be an http:// or https:// address",
    ]);
  });

  it("email settings: both or neither, and well-formed", () => {
    expect(problemsOf({ ...devEnv, RESEND_API_KEY: RESEND.RESEND_API_KEY })).toEqual([
      "RESEND_API_KEY and EMAIL_FROM must be set together",
    ]);
    expect(problemsOf({ ...devEnv, ...RESEND, RESEND_API_KEY: "not-a-resend-key" })).toEqual([
      "RESEND_API_KEY does not look like a Resend API key (it starts with re_)",
    ]);
    expect(problemsOf({ ...devEnv, ...RESEND, EMAIL_FROM: "not an address" })).toEqual([
      'EMAIL_FROM must be an email address, e.g. "Shop <noreply@yourdomain.com>"',
    ]);
  });

  it.each(["onboarding@resend.dev", "Sharma Textiles <noreply@sharma.in>"])("accepts the sender %s", (from) => {
    expect(parseEnv({ ...devEnv, ...RESEND, EMAIL_FROM: from }).email?.from).toBe(from);
  });

  it("unknown NODE_ENV", () => {
    expect(problemsOf({ ...devEnv, NODE_ENV: "staging" })).toEqual(["NODE_ENV must be development, test or production"]);
  });
});

describe("parseEnv: never reveals values", () => {
  const marker = "leak-check-marker";

  it.each([
    { ...devEnv, DATABASE_URL_DEV: `https://localhost/${marker}` },
    { ...devEnv, DATABASE_URL_DEV: `${marker} not a url` },
    { ...devEnv, BETTER_AUTH_SECRET: marker },
    { ...devEnv, ...RESEND, RESEND_API_KEY: `${marker}-not-resend` },
    { ...testEnv, DATABASE_URL_DEV: `postgres://localhost/${marker}`, DATABASE_URL_TEST: `postgres://localhost/${marker}` },
  ])("error message hides the value (%#)", (source) => {
    let message = "";
    try {
      parseEnv(source);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(marker);
  });
});

describe("error monitoring address (Phase 11)", () => {
  it("is optional, and must be an https address when given", () => {
    expect(() => parseEnv({ ...devEnv })).not.toThrow();
    expect(() => parseEnv({ ...devEnv, SENTRY_DSN: "https://abc@o1.ingest.sentry.io/2" })).not.toThrow();
    expect(problemsOf({ ...devEnv, SENTRY_DSN: "http://abc@o1.ingest.sentry.io/2" })).toEqual(["SENTRY_DSN must be the https:// address Sentry shows (Client Keys / DSN)"]);
  });
});

describe("health drill switch (Phase 11)", () => {
  it("off by default; only the word fail switches it on", () => {
    expect(parseEnv({ ...devEnv }).healthDrill).toBe(false);
    expect(parseEnv({ ...devEnv, HEALTH_DRILL: "fail" }).healthDrill).toBe(true);
    expect(problemsOf({ ...devEnv, HEALTH_DRILL: "yes" })).toEqual(['HEALTH_DRILL may only be "fail" (or left out)']);
  });
});
