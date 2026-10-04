// Writing CSV files for spreadsheets (report exports). Every cell is quoted.
// A cell starting with = + - @ (or a tab or carriage return) could run as a
// formula when opened in Excel or Sheets ("CSV injection"), so it gets a
// leading apostrophe and is shown as plain text. Lines end with CRLF, and a
// byte-order mark lets Excel read ₹ and other characters correctly.

const FORMULA_START = /^[=+\-@\t\r]/;
// A plain number such as -799.50 cannot be a formula and must stay a number.
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function csvCell(value: string | number): string {
  let text = typeof value === "number" ? String(value) : value;
  if (typeof value === "string" && FORMULA_START.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(rows: (string | number)[][]): string {
  return `﻿${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
