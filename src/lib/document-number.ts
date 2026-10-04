// Bill and credit-note numbers (owner decision 2026-10-02, business rules
// section 5 and 12): PREFIX/YY-YY/NNNNN, e.g. INV/26-27/00001.
// - PREFIX: 1-4 capital letters or digits (a till's own prefix later too).
// - YY-YY: the financial year, which starts in the business's start month
//   (April) in the business's time zone.
// - NNNNN: 5 digits, 00001-99999, restarting each financial year.
// At most 16 characters, the GST limit (open question 4: accountant to
// confirm). Pure functions (also used by the offline till); the counter is in
// src/modules/sales/sequence.ts.

export const PREFIX_PATTERN = /^[A-Z0-9]{1,4}$/;
export const NUMBER_DIGITS = 5;
export const MAX_NUMBER = 99_999;
export const MAX_LENGTH = 16;

// The calendar year in which the financial year containing `at` began, as
// seen in the business's time zone (rule 1.5: day boundaries are local).
export function financialYearStart(at: Date, timeZone: string, startMonth: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric" }).formatToParts(at);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  if (!Number.isInteger(year) || !Number.isInteger(month)) throw new Error("financialYearStart: bad date");
  return month >= startMonth ? year : year - 1;
}

// "26-27" for the year starting April 2026; a January start is just "2026".
export function financialYearLabel(startYear: number, startMonth: number): string {
  if (startMonth === 1) return String(startYear);
  const two = (y: number): string => String(y % 100).padStart(2, "0");
  return `${two(startYear)}-${two(startYear + 1)}`;
}

export function formatDocumentNumber(prefix: string, financialYear: string, number: number): string {
  if (!PREFIX_PATTERN.test(prefix)) throw new Error("formatDocumentNumber: bad prefix");
  if (!Number.isInteger(number) || number < 1 || number > MAX_NUMBER) {
    throw new Error("formatDocumentNumber: number out of range");
  }
  const formatted = `${prefix}/${financialYear}/${String(number).padStart(NUMBER_DIGITS, "0")}`;
  if (formatted.length > MAX_LENGTH) throw new Error("formatDocumentNumber: longer than 16 characters");
  return formatted;
}

// The financial year label of a calendar day (YYYY-MM-DD, already in the
// business's time zone), e.g. "2026-10-04" with an April start -> "26-27".
export function financialYearOfDay(day: string, startMonth: number): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(day);
  if (match === null) throw new Error("financialYearOfDay: bad day");
  const year = Number(match[1]);
  const month = Number(match[2]);
  return financialYearLabel(month >= startMonth ? year : year - 1, startMonth);
}

// A registered till's own series (decision 0006): its bills use its prefix
// (1-3 characters), its credit notes the prefix + "R".
export const TILL_PREFIX_PATTERN = /^[A-Z0-9]{1,3}$/;
export const tillCreditNotePrefix = (tillPrefix: string): string => `${tillPrefix}R`;

// "T1/26-27/00012" -> its parts, or null if it is not a document number.
export function parseDocumentNumber(text: string): { prefix: string; financialYear: string; number: number } | null {
  const match = /^([A-Z0-9]{1,4})\/(\d{2}-\d{2}|\d{4})\/(\d{5})$/.exec(text);
  if (match === null) return null;
  const number = Number(match[3]);
  if (number < 1) return null;
  return { prefix: match[1] ?? "", financialYear: match[2] ?? "", number };
}
