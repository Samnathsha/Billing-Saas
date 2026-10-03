// Stock quantities arrive as decimal text with 3 places ("2.500"). Shown
// without trailing zeros ("2.5", "10"), exactly; never through floating point.
export function formatQuantity(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (match === null) return text;
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const whole = match[2]?.replace(/^0+(?=\d)/, "") ?? "0";
  const sign = whole === "0" && fraction === "" ? "" : (match[1] ?? "");
  return `${sign}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}
