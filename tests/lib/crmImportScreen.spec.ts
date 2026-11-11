import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ImportContacts, {
  batchStatus,
  importErrorWords,
} from '@/components/admin/screens/contacts-import/ImportContacts';
import { AdminApiError } from '@/lib/admin/client';
import {
  addPiece,
  EMPTY_TALLY,
  problemGroups,
  readImportFile,
  rowList,
  tallyLines,
} from '@/lib/crm/importScreen';
import { parseCsv } from '@/lib/crm/importCsv';
import { ImportRowsSchema, IMPORT_PIECE_ROWS } from '@schemas/crmImport';
import type { ImportBatch } from '@/lib/crm/importBatches';

// Import contacts' screen (Admin v2 C15): the first render (no style attribute, states in
// words, the statement to tick, the recent imports and who made them), the browser's reading of
// a file (what a person can fix first, by row and column number; pieces of at most 50 people
// whose bodies the route's schema takes, row numbers that skip blank rows), and the result in
// sentences. No cell of a file is ever repeated in the screen's words.

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const batch = (over: Partial<ImportBatch>): ImportBatch => ({
  id: '22222222-2222-4222-8222-222222222222',
  status: 'done',
  createdBy: ME,
  createdAt: '2026-11-11T08:00:00Z',
  finishedAt: '2026-11-11T08:01:00Z',
  expectedRows: 3,
  rows: 3,
  created: 2,
  duplicates: 1,
  repeats: 0,
  failed: 0,
  phoneMatches: 0,
  ...over,
});

describe('the first render', () => {
  const html = renderToStaticMarkup(
    createElement(ImportContacts, {
      initialBatches: [
        batch({}),
        batch({ id: 'b2', createdBy: OTHER, status: 'open', createdAt: '2026-11-11T01:00:00Z' }),
        batch({ id: 'b3', createdBy: null, status: 'stopped' }),
      ],
      names: { [OTHER]: 'Amal' },
      me: ME,
      now: '2026-11-11T10:00:00Z',
    }),
  );

  it('draws no style attribute (style-src has no unsafe-inline)', () => {
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('offers the template, the columns, the file picker and the statement to tick', () => {
    expect(html).toContain('href="/api/admin/crm/contacts/import/template"');
    expect(html).toContain('Download the template');
    expect(html).toContain('<code>lawful_basis</code>');
    expect(html).toMatch(/type="file"[^>]*accept=".csv,text\/csv"/);
    expect(html).toContain('I confirm we may hold each person’s details on the lawful basis');
    expect(html).toContain('None of these lets us send marketing.');
    // Nothing to import until a file is read.
    expect(html).toMatch(/<button type="submit" data-variant="primary" disabled="">Import<\/button>/);
  });

  it('lists the recent imports with who made them and their state in words', () => {
    expect(html).toContain('>You<');
    expect(html).toContain('>Amal<');
    expect(html).toContain('A former colleague');
    expect(html).toContain('>Done<');
    expect(html).toContain('Stopped before the end');
    expect(html).toContain('>Stopped<');
  });

  it('keeps P-12: no em or en dash in the screen’s words', () => {
    const source = readFileSync('src/components/admin/screens/contacts-import/ImportContacts.tsx', 'utf8');
    const words = readFileSync('src/lib/crm/importScreen.ts', 'utf8');
    for (const text of [html, source, words]) expect(text).not.toMatch(/[—–]/);
  });
});

describe('batchStatus', () => {
  it('an open import older than two hours stopped before the end', () => {
    const now = Date.parse('2026-11-11T10:00:00Z');
    expect(batchStatus(batch({ status: 'open', createdAt: '2026-11-11T09:30:00Z' }), now)).toBe(
      'In progress',
    );
    expect(batchStatus(batch({ status: 'open', createdAt: '2026-11-11T07:00:00Z' }), now)).toBe(
      'Stopped before the end',
    );
  });
});

describe('reading a file in the browser', () => {
  const PRIVATE = 'secret.person@example.test';

  it('refuses what a person can fix, by number, never repeating a cell', () => {
    const cases: [string, string][] = [
      ['', 'The file is empty.'],
      [`name,email,lawful_basis\n"${PRIVATE},consent\n`, 'from row 2 on'],
      [`name,email,Email,lawful_basis\nA,${PRIVATE},x,consent\n`, 'Column 3 repeats a heading'],
      [`email,lawful_basis\n${PRIVATE},consent\n`, 'no name column'],
      [`name,email\nA,${PRIVATE}\n`, 'no lawful_basis column'],
      ['name,lawful_basis\nA,consent\n', 'no email or phone column'],
      ['name,email,lawful_basis\n,,\n', 'nobody under them'],
      ['name,email,lawful_basis\nA�b,x,consent\n', 'not saved as UTF-8'],
    ];
    for (const [text, words] of cases) {
      const reading = readImportFile(text, text.length);
      expect(reading.ok, words).toBe(false);
      if (!reading.ok) {
        expect(reading.message).toContain(words);
        expect(reading.message).not.toContain(PRIVATE);
      }
    }
    expect(readImportFile('name,email,lawful_basis\n', 3 * 1024 * 1024)).toEqual({
      ok: false,
      message: 'The file is larger than 2 MB. Split it into smaller files.',
    });
  });

  it('counts people (not blank rows), names the columns left out, and cuts pieces the route takes', () => {
    const lines = ['Name,Notes,Email,Lawful basis'];
    for (let i = 0; i < 120; i += 1) {
      lines.push(`Person ${i},private note ${i},p${i}@example.test,consent`);
      if (i === 10) lines.push(',,,');
    }
    const text = `${lines.join('\r\n')}\r\n`;
    const reading = readImportFile(text, text.length);
    if (!reading.ok) throw new Error(reading.message);
    expect(reading.people).toBe(120);
    expect(reading.ignored).toEqual([2]);
    expect(reading.columns).toEqual(['name', 'email', 'lawful_basis']);
    expect(reading.pieces.map((p) => p.rowNumbers.length)).toEqual([50, 50, 20]);
    // Row 13 is the blank one: the 12th person (index 11) is row 14.
    expect(reading.pieces[0]?.rowNumbers.slice(10, 13)).toEqual([12, 14, 15]);
    for (const piece of reading.pieces) {
      expect(piece.rowNumbers.length).toBeLessThanOrEqual(IMPORT_PIECE_ROWS);
      expect(
        ImportRowsSchema.safeParse({
          step: 'rows',
          batchId: '22222222-2222-4222-8222-222222222222',
          ...piece,
        }).success,
      ).toBe(true);
      // The left-out column never leaves the browser.
      expect(piece.csv).not.toContain('private note');
      const back = parseCsv(piece.csv, { maxRecords: 300, maxColumns: 32, maxCellLength: 2000 });
      expect(back.ok && back.records.length - 1).toBe(piece.rowNumbers.length);
    }
  });
});

describe('the result in words', () => {
  it('sums the pieces and says each outcome with its rows by number', () => {
    let tally = addPiece(EMPTY_TALLY, 50, {
      created: 46,
      duplicates: [3, 5],
      repeats: [{ row: 9, of: 4 }],
      phoneMatches: [12],
      problems: [{ row: 7, problem: 'basis_missing' }],
    });
    tally = addPiece(tally, 2, {
      created: 1,
      duplicates: [],
      repeats: [],
      phoneMatches: [],
      problems: [{ row: 60, problem: 'basis_missing' }],
      leaked: 'secret',
    });
    expect(tally.sent).toBe(52);
    expect(tallyLines(tally)).toEqual([
      'Added 47 people.',
      'Already contacts, so left as they are: 2 rows (3 and 5).',
      'Repeated in the file, so added once: row 9 repeats row 4.',
      'Added, but another contact has the same phone number, so please check: 1 row (12).',
    ]);
    expect(problemGroups(tally.problems)).toEqual([
      { why: 'no lawful basis', rows: '7 and 60', count: 2 },
    ]);
  });

  it('a long list of rows is cut short', () => {
    expect(rowList(Array.from({ length: 35 }, (_, i) => i + 2), 30)).toMatch(/and 5 more$/);
    expect(rowList([9])).toBe('9');
  });

  it('a refusal in words: the limit, a closed import, the route’s own words', () => {
    expect(importErrorWords(new AdminApiError({ error: 'rate-limit', status: 429 }))).toContain(
      'hourly limit',
    );
    expect(importErrorWords(new AdminApiError({ error: 'not-found', status: 404 }))).toContain(
      'This import has closed',
    );
    expect(
      importErrorWords(
        new AdminApiError({ error: 'validation', status: 422, detail: 'Column 3 repeats a heading.' }),
      ),
    ).toBe('Column 3 repeats a heading.');
  });
});
