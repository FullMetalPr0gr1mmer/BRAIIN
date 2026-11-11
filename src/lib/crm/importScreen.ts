import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  IMPORT_PIECE_MAX_CHARS,
  IMPORT_PIECE_ROWS,
  type ImportColumn,
} from '@schemas/crmImport';
import { encodePiece, FILE_LIMITS, isBlankRecord, mapHeadings, parseCsv } from './importCsv';

// The import screen's own reading of a file (Admin v2 C15): enough to show what the file holds
// and to cut it into pieces at record boundaries, before anything is sent. It is the screen's
// help, not the check: the import route parses every piece again and decides. Pure: the tests
// run it without a browser. Its words name rows and columns by number, never a cell.

/** What the screen calls each import column. */
export const COLUMN_LABELS: Readonly<Record<ImportColumn, string>> = {
  name: 'Name',
  email: 'E-mail',
  phone: 'Phone',
  company: 'Company',
  title: 'Title',
  city: 'City',
  country: 'Country',
  language: 'Language',
  stage: 'Stage',
  tags: 'Tags',
  lawful_basis: 'Lawful basis',
};

export interface ImportPiece {
  rowNumbers: number[];
  csv: string;
}

export type FileReading =
  | {
      ok: true;
      people: number;
      bytes: number;
      columns: ImportColumn[];
      /** The 1-based numbers of the columns left out. */
      ignored: number[];
      pieces: ImportPiece[];
    }
  | { ok: false; message: string };

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Reads a chosen file's text: the checks a person can fix before importing. */
export function readImportFile(text: string, bytes: number): FileReading {
  if (bytes > IMPORT_MAX_BYTES) {
    return { ok: false, message: 'The file is larger than 2 MB. Split it into smaller files.' };
  }
  if (text.includes('�')) {
    return {
      ok: false,
      message:
        'The file is not saved as UTF-8, so some letters cannot be read. In your spreadsheet, save it as "CSV UTF-8" and choose it again.',
    };
  }
  const parsed = parseCsv(text, FILE_LIMITS);
  if (!parsed.ok) {
    switch (parsed.problem) {
      case 'empty':
        return { ok: false, message: 'The file is empty.' };
      case 'binary':
        return {
          ok: false,
          message:
            'This is not a CSV file. Save the spreadsheet as "CSV UTF-8" and choose it again.',
        };
      case 'unclosed_quote':
        return {
          ok: false,
          message: `A quotation mark is never closed, from row ${parsed.row ?? 1} on.`,
        };
      case 'too_many_columns':
        return { ok: false, message: `Row ${parsed.row ?? 1} has more than 32 columns.` };
      case 'cell_too_long':
        return {
          ok: false,
          message: `Row ${parsed.row ?? 1} has a cell longer than 2,000 characters.`,
        };
      case 'too_many_rows':
        return { ok: false, message: 'The file has too many rows. Import at most 5,000 people.' };
    }
  }
  const [headings = [], ...rest] = parsed.records;
  const mapped = mapHeadings(headings);
  if (!mapped.ok) {
    switch (mapped.problem) {
      case 'heading_twice':
        return {
          ok: false,
          message: `Column ${mapped.column ?? 1} repeats a heading another column already uses.`,
        };
      case 'no_name':
        return {
          ok: false,
          message: 'The file has no name column. Use the template’s headings in the first row.',
        };
      case 'no_basis':
        return {
          ok: false,
          message: 'The file has no lawful_basis column. Every person needs a lawful basis.',
        };
      case 'no_contact_column':
        return {
          ok: false,
          message: 'The file has no email or phone column. We need one to tell people apart.',
        };
    }
  }

  const people: { row: number; record: string[] }[] = [];
  rest.forEach((record, index) => {
    if (!isBlankRecord(record)) people.push({ row: index + 2, record });
  });
  if (people.length === 0) {
    return { ok: false, message: 'The file has headings but nobody under them.' };
  }
  if (people.length > IMPORT_MAX_ROWS) {
    return {
      ok: false,
      message: `The file has ${plural(people.length, 'person', 'people')}. Import at most 5,000 at a time.`,
    };
  }

  // Pieces of at most 50 people and well under the route's text cap.
  const pieces: ImportPiece[] = [];
  let batch: { row: number; record: string[] }[] = [];
  let size = 0;
  const flush = () => {
    if (batch.length === 0) return;
    pieces.push({
      rowNumbers: batch.map((p) => p.row),
      csv: encodePiece(
        mapped.columns,
        batch.map((p) => p.record),
      ),
    });
    batch = [];
    size = 0;
  };
  for (const person of people) {
    const length = person.record.reduce((n, cell) => n + cell.length + 3, 1);
    if (batch.length >= IMPORT_PIECE_ROWS || size + length > IMPORT_PIECE_MAX_CHARS - 1000) flush();
    batch.push(person);
    size += length;
  }
  flush();

  return {
    ok: true,
    people: people.length,
    bytes,
    columns: mapped.columns.filter((c): c is ImportColumn => c !== null),
    ignored: mapped.ignored,
    pieces,
  };
}

/** Why rows were not imported, in words (the route's codes). */
export const PROBLEM_WORDS: Readonly<Record<string, string>> = {
  name_missing: 'no name',
  name: 'the name is longer than 120 characters or has characters we cannot store',
  email: 'the e-mail address cannot be read',
  phone: 'the phone number cannot be read',
  no_contact: 'no e-mail or phone',
  basis_missing: 'no lawful basis',
  basis:
    'the lawful basis is not one of consent, contract, legitimate_interest or legal_obligation',
  stage: 'the stage is not lead, client, past or partner',
  language: 'the language is not en or ar',
  country: 'the country is not a two-letter code, like SA',
  tags: 'more than 10 tags, or a tag longer than 32 characters',
  company: 'the company is longer than 120 characters',
  title: 'the title is longer than 120 characters',
  city: 'the city is longer than 80 characters',
  columns: 'more cells than there are headings',
  refused: 'a value could not be stored',
};

/** "2, 5 and 9", at most `max` numbers, then "and 12 more". */
export function rowList(rows: readonly number[], max = 30): string {
  const sorted = [...rows].sort((a, b) => a - b);
  const shown = sorted.slice(0, max).map((n) => n.toLocaleString('en-US'));
  const more = sorted.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more.toLocaleString('en-US')} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** The running result of an import, summed piece by piece. */
export interface ImportTally {
  sent: number;
  created: number;
  duplicates: number[];
  repeats: { row: number; of: number }[];
  phoneMatches: number[];
  problems: { row: number; problem: string }[];
}

export const EMPTY_TALLY: ImportTally = {
  sent: 0,
  created: 0,
  duplicates: [],
  repeats: [],
  phoneMatches: [],
  problems: [],
};

/** Adds one piece's answer (named fields only) to the tally. */
export function addPiece(tally: ImportTally, sent: number, answer: unknown): ImportTally {
  const a = (answer && typeof answer === 'object' ? answer : {}) as Record<string, unknown>;
  const ints = (v: unknown) =>
    Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : [];
  const repeats = Array.isArray(a['repeats'])
    ? (a['repeats'] as Record<string, unknown>[]).flatMap((r) =>
        typeof r?.['row'] === 'number' && typeof r?.['of'] === 'number'
          ? [{ row: r['row'], of: r['of'] }]
          : [],
      )
    : [];
  const problems = Array.isArray(a['problems'])
    ? (a['problems'] as Record<string, unknown>[]).flatMap((p) =>
        typeof p?.['row'] === 'number' && typeof p?.['problem'] === 'string'
          ? [{ row: p['row'], problem: p['problem'] }]
          : [],
      )
    : [];
  return {
    sent: tally.sent + sent,
    created: tally.created + (typeof a['created'] === 'number' ? a['created'] : 0),
    duplicates: [...tally.duplicates, ...ints(a['duplicates'])],
    repeats: [...tally.repeats, ...repeats],
    phoneMatches: [...tally.phoneMatches, ...ints(a['phoneMatches'])],
    problems: [...tally.problems, ...problems],
  };
}

/** The result in sentences, each with its rows by number. */
export function tallyLines(tally: ImportTally): string[] {
  const lines = [`Added ${plural(tally.created, 'person', 'people')}.`];
  if (tally.duplicates.length > 0) {
    lines.push(
      `Already contacts, so left as they are: ${plural(tally.duplicates.length, 'row', 'rows')} (${rowList(tally.duplicates)}).`,
    );
  }
  if (tally.repeats.length > 0) {
    lines.push(
      `Repeated in the file, so added once: ${tally.repeats
        .slice(0, 30)
        .map((r) => `row ${r.row} repeats row ${r.of}`)
        .join(', ')}${tally.repeats.length > 30 ? ` and ${tally.repeats.length - 30} more` : ''}.`,
    );
  }
  if (tally.phoneMatches.length > 0) {
    lines.push(
      `Added, but another contact has the same phone number, so please check: ${plural(tally.phoneMatches.length, 'row', 'rows')} (${rowList(tally.phoneMatches)}).`,
    );
  }
  return lines;
}

/** The rows not imported, grouped by why. */
export function problemGroups(
  problems: readonly { row: number; problem: string }[],
): { why: string; rows: string; count: number }[] {
  const byCode = new Map<string, number[]>();
  for (const p of problems) byCode.set(p.problem, [...(byCode.get(p.problem) ?? []), p.row]);
  return [...byCode.entries()].map(([code, rows]) => ({
    why: PROBLEM_WORDS[code] ?? 'a value could not be stored',
    rows: rowList(rows),
    count: rows.length,
  }));
}
