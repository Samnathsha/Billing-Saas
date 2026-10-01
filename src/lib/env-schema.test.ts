import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "./env-schema";

const DEV = "postgres://localhost:5432/billing_dev";
const TEST = "postgresql://localhost:5432/billing_test";

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
  it("development uses DATABASE_URL_DEV", () => {
    expect(parseEnv({ NODE_ENV: "development", DATABASE_URL_DEV: DEV })).toEqual({
      mode: "development",
      databaseUrl: DEV,
    });
  });

  it("missing NODE_ENV means development", () => {
    expect(parseEnv({ DATABASE_URL_DEV: DEV }).mode).toBe("development");
  });

  it("test uses DATABASE_URL_TEST", () => {
    expect(parseEnv({ NODE_ENV: "test", DATABASE_URL_TEST: TEST, DATABASE_URL_DEV: DEV })).toEqual({
      mode: "test",
      databaseUrl: TEST,
    });
  });

  it("a local production build uses DATABASE_URL_DEV for now", () => {
    expect(parseEnv({ NODE_ENV: "production", DATABASE_URL_DEV: DEV }).databaseUrl).toBe(DEV);
  });

  it("ignores unrelated variables", () => {
    expect(parseEnv({ DATABASE_URL_DEV: DEV, PATH: "/usr/bin", HOME: "/Users/x" }).databaseUrl).toBe(DEV);
  });
});

describe("parseEnv: stops on bad settings", () => {
  it("development without DATABASE_URL_DEV", () => {
    expect(problemsOf({ NODE_ENV: "development" })).toEqual(["DATABASE_URL_DEV is missing"]);
  });

  it("an empty value counts as missing", () => {
    expect(problemsOf({ DATABASE_URL_DEV: "" })).toEqual(["DATABASE_URL_DEV is missing"]);
  });

  it("test without DATABASE_URL_TEST, even if DEV is set", () => {
    expect(problemsOf({ NODE_ENV: "test", DATABASE_URL_DEV: DEV })).toEqual(["DATABASE_URL_TEST is missing"]);
  });

  it.each(["https://localhost/billing", "mysql://localhost/billing", "not a url", "localhost:5432"])(
    "rejects a non-Postgres value: %s",
    (value) => {
      expect(problemsOf({ DATABASE_URL_DEV: value })).toEqual([
        "DATABASE_URL_DEV must be a postgres:// or postgresql:// connection string",
      ]);
    },
  );

  it("rejects a bad optional URL too", () => {
    expect(problemsOf({ DATABASE_URL_DEV: DEV, DATABASE_URL_TEST: "nope" })).toEqual([
      "DATABASE_URL_TEST must be a postgres:// or postgresql:// connection string",
    ]);
  });

  it("dev and test must be different databases", () => {
    expect(problemsOf({ NODE_ENV: "test", DATABASE_URL_DEV: TEST, DATABASE_URL_TEST: TEST })).toEqual([
      "DATABASE_URL_DEV and DATABASE_URL_TEST must point to different databases",
    ]);
  });

  it("unknown NODE_ENV", () => {
    expect(problemsOf({ NODE_ENV: "staging", DATABASE_URL_DEV: DEV })).toEqual([
      "NODE_ENV must be development, test or production",
    ]);
  });
});

describe("parseEnv: never reveals values", () => {
  const marker = "leak-check-marker";

  it.each([
    { DATABASE_URL_DEV: `https://localhost/${marker}` },
    { DATABASE_URL_DEV: `${marker} not a url` },
    { NODE_ENV: "test", DATABASE_URL_DEV: `postgres://localhost/${marker}`, DATABASE_URL_TEST: `postgres://localhost/${marker}` },
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
