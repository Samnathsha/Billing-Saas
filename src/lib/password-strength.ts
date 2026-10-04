// A simple strength guide for new passwords (OWASP ASVS 2.1.8). Length
// matters most (rule: at least 12 characters, no composition rules, ASVS
// 2.1.9); variety helps a little. The real checks are on the server: the
// minimum length and the breached-password list.

export type Strength = "too_short" | "ok" | "good" | "strong";

export function passwordStrength(password: string, minimum = 12): Strength {
  // The same count the server uses for the minimum.
  const length = password.length;
  if (length < minimum) return "too_short";
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (length >= 20 || (length >= 16 && kinds >= 3)) return "strong";
  if (length >= 16 || kinds >= 3) return "good";
  return "ok";
}

export const STRENGTH_TEXT: Record<Strength, string> = {
  too_short: "Too short",
  ok: "OK. Longer is stronger: a few unrelated words work well.",
  good: "Good",
  strong: "Strong",
};
