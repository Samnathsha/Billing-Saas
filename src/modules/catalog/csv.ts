// Minimal CSV reader (RFC 4180): commas, double-quoted fields with "" for a
// quote, CRLF or LF line ends, an optional byte-order mark (Excel). Returns
// rows of strings; never evaluates anything (no formulas, no types).

export function parseCsv(text: string): string[][] {
  const input = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < input.length) {
    const c = input.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (input.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += c;
      }
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (c === "\r" && input.charAt(i + 1) === "\n") i++;
    } else {
      field += c;
    }
    i++;
  }
  if (quoted) throw new Error("CSV: a quoted field is not closed");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Skip fully empty lines.
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}
