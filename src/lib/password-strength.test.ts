import { describe, expect, it } from "vitest";
import { passwordStrength } from "./password-strength";

describe("password strength guide", () => {
  it("length first, then variety", () => {
    expect(passwordStrength("short")).toBe("too_short");
    expect(passwordStrength("elevenchars")).toBe("too_short");
    expect(passwordStrength("twelvechars!")).toBe("ok");
    expect(passwordStrength("Twelvechars1")).toBe("good");
    expect(passwordStrength("sixteen letters x")).toBe("good");
    expect(passwordStrength("Sixteen Letters 9")).toBe("strong");
    expect(passwordStrength("a long flow passphrase 2026")).toBe("strong");
  });

  it("counts like the server (UTF-16 length)", () => {
    expect(passwordStrength("ரூபாய்ரூபாய்ரூ")).not.toBe("too_short");
  });
});
