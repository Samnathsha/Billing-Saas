import { describe, expect, it } from "vitest";
import { connectionUrl, updateEnvLines, valueOf, withStrictSsl } from "./env-file";

// Made-up hosts and passwords.
const NEON_DIRECT = "postgresql://neondb_owner:ownerpw@ep-cool-name-a1b2c3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const NEON_POOLED = "postgresql://neondb_owner:ownerpw@ep-cool-name-a1b2c3-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

describe("connectionUrl", () => {
  it.each([NEON_DIRECT, NEON_POOLED])("Neon app_user gets the pooled host: %s", (base) => {
    const url = new URL(connectionUrl(base, "app_user", "newpw", true));
    expect(url.username).toBe("app_user");
    expect(url.password).toBe("newpw");
    expect(url.hostname).toBe("ep-cool-name-a1b2c3-pooler.ap-southeast-1.aws.neon.tech");
    expect(url.pathname).toBe("/neondb");
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
  });

  it.each([NEON_DIRECT, NEON_POOLED])("Neon migrator gets the direct host: %s", (base) => {
    const url = new URL(connectionUrl(base, "migrator", "newpw", false));
    expect(url.username).toBe("migrator");
    expect(url.hostname).toBe("ep-cool-name-a1b2c3.ap-southeast-1.aws.neon.tech");
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
  });

  it("keeps other Neon options", () => {
    const url = new URL(connectionUrl(NEON_DIRECT, "migrator", "pw", false));
    expect(url.searchParams.get("channel_binding")).toBe("require");
  });

  it("leaves non-Neon hosts and SSL settings alone", () => {
    const url = new URL(connectionUrl("postgresql://owner:pw@localhost:55432/neondb", "app_user", "newpw", true));
    expect(url.host).toBe("localhost:55432");
    expect(url.searchParams.has("sslmode")).toBe(false);
  });

  it("random base64url passwords need no escaping", () => {
    const password = "Ab-_09xyzAB-_09xyzAB-_09xyzAB-_09xyzAB-_09x";
    expect(new URL(connectionUrl(NEON_DIRECT, "app_user", password, true)).password).toBe(password);
  });
});

describe("withStrictSsl", () => {
  it("upgrades Neon to verify-full and leaves localhost alone", () => {
    expect(new URL(withStrictSsl(NEON_DIRECT)).searchParams.get("sslmode")).toBe("verify-full");
    expect(withStrictSsl("postgresql://u:p@localhost/db")).toBe("postgresql://u:p@localhost/db");
  });
});

describe("valueOf", () => {
  const lines = ['A="quoted"', "B='single'", "C=plain", "D=", "# E=comment", "AB=other"];

  it("reads plain and quoted values", () => {
    expect(valueOf(lines, "A")).toBe("quoted");
    expect(valueOf(lines, "B")).toBe("single");
    expect(valueOf(lines, "C")).toBe("plain");
  });

  it("treats empty, commented and missing keys as missing", () => {
    expect(valueOf(lines, "D")).toBeUndefined();
    expect(valueOf(lines, "E")).toBeUndefined();
    expect(valueOf(lines, "Z")).toBeUndefined();
  });

  it("does not match a key that only starts the same", () => {
    expect(valueOf(["AB=other"], "A")).toBeUndefined();
  });
});

describe("updateEnvLines", () => {
  const lines = ["# my settings", "DATABASE_URL_DEV=old", "OTHER=keep", "OWNER_DATABASE_URL_DEV=owner", ""];

  it("replaces, appends and removes, keeping everything else", () => {
    expect(
      updateEnvLines(lines, { DATABASE_URL_DEV: "new", MIGRATOR_DATABASE_URL_DEV: "mig" }, ["OWNER_DATABASE_URL_DEV"]),
    ).toBe("# my settings\nDATABASE_URL_DEV=new\nOTHER=keep\nMIGRATOR_DATABASE_URL_DEV=mig\n");
  });

  it("updates in place when the key already exists", () => {
    expect(updateEnvLines(["X=1", "Y=2"], { X: "9" }, [])).toBe("X=9\nY=2\n");
  });

  it("does not touch a key that only starts the same", () => {
    expect(updateEnvLines(["DATABASE_URL_DEV_OLD=keep"], { DATABASE_URL_DEV: "new" }, [])).toBe(
      "DATABASE_URL_DEV_OLD=keep\nDATABASE_URL_DEV=new\n",
    );
  });
});
