// Rupees typed by people <-> integer paise stored by the app (rule 1.2).
// Pure string and integer arithmetic: never floating point.

const RUPEES = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

// "799", "799.5", "799.50", "1,49,999.00", " 12 " -> paise. Anything else
// (negative, three decimals, letters, empty) -> null.
export function rupeesToPaise(text: string): number | null {
  const cleaned = text.trim().replace(/,/g, "").replace(/^₹\s*/, "");
  const match = RUPEES.exec(cleaned);
  if (match === null) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  return whole * 100 + fraction;
}

// 79950 -> "799.50" (for form fields).
export function paiseToRupeesText(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new Error("paiseToRupeesText: not a whole number of paise");
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  return `${sign}${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, "0")}`;
}

// 14999900 -> "₹1,49,999.00" (Indian grouping, for display).
export function formatPaise(paise: number): string {
  const [whole = "0", fraction = "00"] = paiseToRupeesText(Math.abs(paise)).split(".");
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${paise < 0 ? "-" : ""}₹${rest === "" ? last3 : `${rest},${last3}`}.${fraction}`;
}

// "1333.3333" (paise with up to 4 decimals, e.g. an average cost) -> 1333,
// rounded half up to the whole paisa, exactly (no floating point). Display
// only; stored values keep their decimals.
export function decimalPaiseToPaise(text: string): number {
  const match = /^(\d{1,14})(?:\.(\d{1,4}))?$/.exec(text.trim());
  if (match === null) throw new Error("decimalPaiseToPaise: not a paise amount");
  const whole = Number(match[1]);
  const firstDecimal = Number((match[2] ?? "0").charAt(0));
  return firstDecimal >= 5 ? whole + 1 : whole;
}
