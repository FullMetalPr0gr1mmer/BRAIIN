import {
  IMPORT_COLUMNS,
  IMPORT_MAX_ROW_NUMBER,
  type ImportColumn,
} from '@schemas/crmImport';

// Reading a contacts CSV (Admin v2 C15). Pure: no I/O, no keys. The import screen runs it to
// show what a file holds and to cut it into pieces at record boundaries; the import route runs
// it again on every piece it receives (the server parses for itself, never trusting the
// browser's reading). Every problem is a code with, at most, a column or row NUMBER: nothing
// here ever repeats a cell's content, which may be a person's details.

/** Why a file (or a piece) cannot be read at all. */
export type CsvProblem =
  | 'empty'
  | 'binary'
  | 'unclosed_quote'
  | 'too_many_columns'
  | 'cell_too_long'
  | 'too_many_rows';

export interface CsvLimits {
  /** Records, the heading row included. */
  maxRecords: number;
  maxColumns: number;
  maxCellLength: number;
}

/** The file's limits: 5,000 people plus blank rows and the heading, at most 32 columns. */
export const FILE_LIMITS: CsvLimits = {
  maxRecords: IMPORT_MAX_ROW_NUMBER,
  maxColumns: 32,
  maxCellLength: 2000,
};

export type CsvResult =
  | { ok: true; records: string[][] }
  | { ok: false; problem: CsvProblem; row?: number };

/** The separator a file uses: the one its heading row holds most of, outside quotes. */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && (ch === ',' || ch === ';' || ch === '\t')) counts[ch] += 1;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
  return ',';
}

/**
 * RFC 4180, leniently: a field may be quoted ("" is a quote inside one); a line ends with CRLF,
 * LF or CR; a quote inside an unquoted field is kept as it is; a BOM is dropped; a final line
 * break adds no record. Row numbers in problems count the heading as row 1.
 */
export function parseCsv(input: string, limits: CsvLimits, delimiter = detectDelimiter(input)): CsvResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.trim() === '') return { ok: false, problem: 'empty' };
  if (text.includes('\u0000')) return { ok: false, problem: 'binary' };
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  let fresh = true; // at the start of a cell
  let i = 0;
  const endCell = (): CsvProblem | null => {
    if (cell.length > limits.maxCellLength) return 'cell_too_long';
    record.push(cell);
    cell = '';
    fresh = true;
    return record.length > limits.maxColumns ? 'too_many_columns' : null;
  };
  const endRecord = (): CsvProblem | null => {
    const problem = endCell();
    if (problem) return problem;
    records.push(record);
    record = [];
    return records.length > limits.maxRecords ? 'too_many_rows' : null;
  };
  while (i < text.length) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && fresh) {
      quoted = true;
      fresh = false;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      const problem = endCell();
      if (problem) return { ok: false, problem, row: records.length + 1 };
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      const problem = endRecord();
      if (problem) return { ok: false, problem, row: records.length + (problem === 'too_many_rows' ? 0 : 1) };
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += ch;
    fresh = false;
    i += 1;
  }
  if (quoted) return { ok: false, problem: 'unclosed_quote', row: records.length + 1 };
  if (!(fresh && record.length === 0 && cell === '')) {
    const problem = endRecord();
    if (problem) return { ok: false, problem, row: records.length + (problem === 'too_many_rows' ? 0 : 1) };
  }
  return { ok: true, records };
}

/** A record with nothing in it (a spreadsheet's trailing ",,,," rows). */
export function isBlankRecord(record: readonly string[]): boolean {
  return record.every((cell) => cell.trim() === '');
}

// ── The heading row ─────────────────────────────────────────────────────────────────────────

/** A heading as typed, folded: case, spaces, dashes and underscores (never digits, P-12). */
function foldHeading(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_\-.]+/g, ' ')
    .trim();
}

/** The headings each column answers to, English and Arabic, already folded. */
const HEADINGS: Readonly<Record<ImportColumn, readonly string[]>> = {
  name: ['name', 'full name', 'display name', 'الاسم', 'الاسم الكامل'],
  email: ['email', 'e mail', 'email address', 'e mail address', 'البريد الإلكتروني', 'البريد'],
  phone: ['phone', 'phone number', 'mobile', 'whatsapp', 'الهاتف', 'رقم الهاتف', 'الجوال', 'الواتساب'],
  company: ['company', 'company name', 'organisation', 'organization', 'الشركة', 'اسم الشركة'],
  title: ['title', 'job title', 'position', 'role', 'المسمى الوظيفي', 'المنصب'],
  city: ['city', 'المدينة'],
  country: ['country', 'country code', 'الدولة', 'البلد'],
  language: ['language', 'locale', 'اللغة'],
  stage: ['stage', 'المرحلة'],
  tags: ['tags', 'tag', 'labels', 'الوسوم', 'التصنيفات'],
  lawful_basis: ['lawful basis', 'legal basis', 'basis', 'الأساس النظامي', 'الأساس القانوني'],
};

const HEADING_COLUMN: ReadonlyMap<string, ImportColumn> = new Map(
  IMPORT_COLUMNS.flatMap((column) =>
    HEADINGS[column].map((heading) => [foldHeading(heading), column] as const),
  ),
);

export type HeadingProblem = 'heading_twice' | 'no_name' | 'no_basis' | 'no_contact_column';

export type HeadingResult =
  | {
      ok: true;
      /** Per column of the file, the import column it is, or null (left out). */
      columns: (ImportColumn | null)[];
      /** The 1-based numbers of the columns left out. */
      ignored: number[];
    }
  | { ok: false; problem: HeadingProblem; column?: number };

/** The import column each heading names; a column named twice, or a missing one, refuses. */
export function mapHeadings(headings: readonly string[]): HeadingResult {
  const columns: (ImportColumn | null)[] = [];
  const ignored: number[] = [];
  const seen = new Set<ImportColumn>();
  headings.forEach((heading, index) => {
    const column = HEADING_COLUMN.get(foldHeading(heading)) ?? null;
    columns.push(column);
    if (column === null && heading.trim() !== '') ignored.push(index + 1);
  });
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    if (!column) continue;
    if (seen.has(column)) return { ok: false, problem: 'heading_twice', column: index + 1 };
    seen.add(column);
  }
  if (!seen.has('name')) return { ok: false, problem: 'no_name' };
  if (!seen.has('lawful_basis')) return { ok: false, problem: 'no_basis' };
  if (!seen.has('email') && !seen.has('phone')) return { ok: false, problem: 'no_contact_column' };
  return { ok: true, columns, ignored };
}

/** One record as the import's columns (a column the file lacks is absent). */
export function recordValues(
  record: readonly string[],
  columns: readonly (ImportColumn | null)[],
): Partial<Record<ImportColumn, string>> {
  const out: Partial<Record<ImportColumn, string>> = {};
  columns.forEach((column, index) => {
    if (column) out[column] = record[index] ?? '';
  });
  return out;
}

// ── Pieces (the screen) ─────────────────────────────────────────────────────────────────────

function encodeCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * A piece of the file for the import route: the import's own headings for the columns the file
 * has (left-out columns are not sent), then each person's cells, comma-separated, quoted only
 * where a cell needs it, so a piece is never much larger than the file's own bytes for it.
 * This text is read back by parseCsv on the server, never opened in a spreadsheet.
 */
export function encodePiece(
  columns: readonly (ImportColumn | null)[],
  records: readonly (readonly string[])[],
): string {
  const kept = columns
    .map((column, index) => ({ column, index }))
    .filter((c): c is { column: ImportColumn; index: number } => c.column !== null);
  const lines = [kept.map((c) => c.column).join(',')];
  for (const record of records) lines.push(kept.map((c) => encodeCell(record[c.index] ?? '')).join(','));
  return `${lines.join('\n')}\n`;
}

/** UTF-8 bytes of a text, as the server counts a piece. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
