import { describe, expect, it } from 'vitest';
import {
  detectDelimiter,
  encodePiece,
  FILE_LIMITS,
  isBlankRecord,
  mapHeadings,
  parseCsv,
  recordValues,
} from '@/lib/crm/importCsv';
import { checkRow, fileProblemMessage, pieceOutcome, ROW_PROBLEMS } from '@/lib/crm/importRows';
import { blindIndex, blindIndexKey, blindIndexWith } from '@/lib/crm/blindIndex';
import { decryptPII, encryptPII, importPIIKey } from '@/lib/crypto/pii';
import { toCsv } from '@/lib/admin/csv';
import { IMPORT_COLUMNS, ImportRequestSchema } from '@schemas/crmImport';

// The CSV import's reading (Admin v2 C15): the parser (RFC 4180, leniently, with limits), the
// heading map (English and Arabic, a column named twice refused by its number), the row checks
// (codes only: no answer repeats what a cell holds), a piece read back exactly as it was cut,
// the template's cells neutralised, and the keys made once giving the same index and a
// ciphertext the reveal can read.

const ok = (text: string) => {
  const r = parseCsv(text, FILE_LIMITS);
  if (!r.ok) throw new Error(`parse failed: ${r.problem}`);
  return r.records;
};

describe('parseCsv', () => {
  it('reads quotes, doubled quotes, separators and line breaks inside quotes', () => {
    expect(ok('name,note\r\n"Sara, Ali","She said ""hi""\nthen left"\r\n')).toEqual([
      ['name', 'note'],
      ['Sara, Ali', 'She said "hi"\nthen left'],
    ]);
  });

  it('drops a BOM, takes LF, CRLF or CR, and adds no record for a final line break', () => {
    expect(ok('﻿a,b\nc,d\re,f\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
    expect(ok('a,b\nc,')).toEqual([
      ['a', 'b'],
      ['c', ''],
    ]);
  });

  it('reads the separator from the heading row: comma, semicolon or tab', () => {
    expect(detectDelimiter('name;email;lawful_basis\nA;b;c')).toBe(';');
    expect(detectDelimiter('name\temail\nA\tb')).toBe('\t');
    expect(detectDelimiter('"a;b",c\n')).toBe(',');
    expect(ok('name;company\nSara;"Acme, Ltd"\n')).toEqual([
      ['name', 'company'],
      ['Sara', 'Acme, Ltd'],
    ]);
  });

  it('refuses an empty file, a binary one, an unclosed quote, and the limits, by row number', () => {
    expect(parseCsv('  \n', FILE_LIMITS)).toEqual({ ok: false, problem: 'empty' });
    expect(parseCsv('a\u0000b', FILE_LIMITS)).toEqual({ ok: false, problem: 'binary' });
    expect(parseCsv('a,b\n"c,d\n', FILE_LIMITS)).toEqual({
      ok: false,
      problem: 'unclosed_quote',
      row: 2,
    });
    const small = { maxRecords: 2, maxColumns: 3, maxCellLength: 5 };
    expect(parseCsv('a\nb\nc\n', small)).toMatchObject({ ok: false, problem: 'too_many_rows' });
    expect(parseCsv('a,b\n1,2,3,4\n', small)).toEqual({
      ok: false,
      problem: 'too_many_columns',
      row: 2,
    });
    expect(parseCsv('a\nabcdef\n', small)).toEqual({ ok: false, problem: 'cell_too_long', row: 2 });
  });

  it('knows a blank record', () => {
    expect(isBlankRecord(['', ' ', ''])).toBe(true);
    expect(isBlankRecord(['', 'x'])).toBe(false);
  });
});

describe('mapHeadings', () => {
  it('maps English and Arabic headings, case and spacing ignored, and names left-out columns by number', () => {
    const result = mapHeadings(['Full Name', 'E-mail', 'الجوال', 'Notes', 'Lawful basis', '']);
    expect(result).toEqual({
      ok: true,
      columns: ['name', 'email', 'phone', null, 'lawful_basis', null],
      ignored: [4],
    });
  });

  it('refuses a heading twice (by its column), and a file without a name, a basis or a way to tell people apart', () => {
    expect(mapHeadings(['name', 'email', 'Email', 'lawful_basis'])).toEqual({
      ok: false,
      problem: 'heading_twice',
      column: 3,
    });
    expect(mapHeadings(['email', 'lawful_basis'])).toEqual({ ok: false, problem: 'no_name' });
    expect(mapHeadings(['name', 'email'])).toEqual({ ok: false, problem: 'no_basis' });
    expect(mapHeadings(['name', 'company', 'lawful_basis'])).toEqual({
      ok: false,
      problem: 'no_contact_column',
    });
  });

  it('the template is the import columns, and every one of them maps to itself', () => {
    const result = mapHeadings([...IMPORT_COLUMNS]);
    expect(result.ok && result.columns).toEqual([...IMPORT_COLUMNS]);
  });
});

describe('checkRow', () => {
  const row = (values: Record<string, string>) => checkRow(7, values);

  it('takes a full row, with Arabic words for the basis, stage and language', () => {
    expect(
      row({
        name: ' سارة علي ',
        email: 'Sara@Example.TEST',
        phone: '050 123 4567',
        company: 'Acme',
        title: 'Buyer',
        city: 'Riyadh',
        country: 'sa',
        language: 'العربية',
        stage: 'عميل سابق',
        tags: 'vip; event|vip',
        lawful_basis: 'مصلحة مشروعة',
      }),
    ).toEqual({
      ok: true,
      row: {
        row: 7,
        basis: 'legitimate_interest',
        displayName: 'سارة علي',
        title: 'Buyer',
        companyName: 'Acme',
        stage: 'past',
        locale: 'ar',
        city: 'Riyadh',
        country: 'SA',
        tags: ['vip', 'event'],
        email: { value: 'Sara@Example.TEST', normalized: 'sara@example.test' },
        phone: { value: '050 123 4567', raw: '050 123 4567' },
      },
    });
  });

  it.each([
    [{ email: 'a@b.co', lawful_basis: 'consent' }, 'name_missing'],
    [{ name: 'x'.repeat(121), email: 'a@b.co', lawful_basis: 'consent' }, 'name'],
    [{ name: 'Sara', email: 'a@b.co' }, 'basis_missing'],
    [{ name: 'Sara', email: 'a@b.co', lawful_basis: 'because' }, 'basis'],
    [{ name: 'Sara', lawful_basis: 'consent' }, 'no_contact'],
    [{ name: 'Sara', email: 'not an address', lawful_basis: 'consent' }, 'email'],
    [{ name: 'Sara', phone: '12', lawful_basis: 'consent' }, 'phone'],
    [{ name: 'Sara', email: 'a@b.co', stage: 'vip', lawful_basis: 'consent' }, 'stage'],
    [{ name: 'Sara', email: 'a@b.co', language: 'fr', lawful_basis: 'consent' }, 'language'],
    [{ name: 'Sara', email: 'a@b.co', country: 'KSA', lawful_basis: 'consent' }, 'country'],
    [
      {
        name: 'Sara',
        email: 'a@b.co',
        tags: Array.from({ length: 11 }, (_, i) => `t${i}`).join(';'),
        lawful_basis: 'consent',
      },
      'tags',
    ],
    [
      { name: 'Sara', email: 'a@b.co', company: 'x'.repeat(121), lawful_basis: 'consent' },
      'company',
    ],
    [{ name: 'Sa\u0007ra', email: 'a@b.co', lawful_basis: 'consent' }, 'name'],
  ])('refuses %j as %s, with its row number and nothing it holds', (values, problem) => {
    const result = row(values);
    expect(result).toEqual({ ok: false, row: 7, problem });
    expect(ROW_PROBLEMS).toContain(problem);
  });

  it('a formula-looking name is kept as text (the exports neutralise it, src/lib/admin/csv.ts)', () => {
    const result = row({ name: '=HYPERLINK("x")', email: 'a@b.co', lawful_basis: 'consent' });
    expect(result.ok && result.row.displayName).toBe('=HYPERLINK("x")');
  });
});

describe('a piece', () => {
  it('leaves out the columns the import does not read, and reads back exactly as it was cut', () => {
    const records = ok(
      'Name,Notes,Email,Lawful basis\n"Ali, Jr.","secret","ali@example.test",consent\n"Sa""ra",x,s@example.test,contract\n',
    );
    const headings = mapHeadings(records[0] as string[]);
    if (!headings.ok) throw new Error('headings');
    const piece = encodePiece(headings.columns, records.slice(1));
    expect(piece).not.toContain('secret');
    const back = ok(piece);
    expect(back).toEqual([
      ['name', 'email', 'lawful_basis'],
      ['Ali, Jr.', 'ali@example.test', 'consent'],
      ['Sa"ra', 's@example.test', 'contract'],
    ]);
    const mapped = mapHeadings(back[0] as string[]);
    expect(mapped.ok && recordValues(back[1] as string[], mapped.columns)).toEqual({
      name: 'Ali, Jr.',
      email: 'ali@example.test',
      lawful_basis: 'consent',
    });
  });
});

describe('the door answer and the words', () => {
  it('keeps numbers only, whatever the door answered', () => {
    const outcome = pieceOutcome(
      {
        created: 2,
        duplicates: [3, 'sara@example.test'],
        repeats: [{ row: 4, of: 2, name: 'Sara' }, { row: 'x' }],
        phone_matches: [6],
        refused: [8],
        leaked: 'a'.repeat(64),
      },
      [{ row: 9, problem: 'email' }],
    );
    expect(outcome).toEqual({
      created: 2,
      duplicates: [3],
      repeats: [{ row: 4, of: 2 }],
      phoneMatches: [6],
      problems: [
        { row: 8, problem: 'refused' },
        { row: 9, problem: 'email' },
      ],
    });
  });

  it('a file problem names a row or a column by number, never a cell', () => {
    expect(fileProblemMessage('heading_twice', 3)).toBe(
      'Column 3 repeats a heading another column already uses.',
    );
    expect(fileProblemMessage('unclosed_quote', 12)).toContain('row 12');
    for (const text of [
      fileProblemMessage('no_name'),
      fileProblemMessage('no_basis'),
      fileProblemMessage('no_contact_column'),
    ]) {
      expect(text).not.toMatch(/[—–]/);
    }
  });
});

describe('the request bodies', () => {
  it('are strict, and refuse a piece of more than 50 people or a file of more than 5,000', () => {
    expect(
      ImportRequestSchema.safeParse({ step: 'open', rows: 5001, bytes: 10, attested: true })
        .success,
    ).toBe(false);
    expect(
      ImportRequestSchema.safeParse({ step: 'open', rows: 5, bytes: 10, attested: false }).success,
    ).toBe(false);
    expect(
      ImportRequestSchema.safeParse({
        step: 'open',
        rows: 5,
        bytes: 10,
        attested: true,
        fileName: 'people.csv',
      }).success,
    ).toBe(false);
    expect(
      ImportRequestSchema.safeParse({
        step: 'rows',
        batchId: '22222222-2222-4222-8222-222222222222',
        rowNumbers: Array.from({ length: 51 }, (_, i) => i + 2),
        csv: 'name\n',
      }).success,
    ).toBe(false);
  });
});

describe('the template and the keys', () => {
  it('the template neutralises any cell a spreadsheet would run as a formula', () => {
    expect(toCsv(['=cmd', '+1', '-2', '@x', 'name'], [])).toBe(
      '﻿"\'=cmd","\'+1","\'-2","\'@x","name"\r\n',
    );
    expect(toCsv(IMPORT_COLUMNS, [])).toBe(`﻿${IMPORT_COLUMNS.map((c) => `"${c}"`).join(',')}\r\n`);
  });

  it('a key made once gives the same blind index, and a ciphertext the reveal reads', async () => {
    const root = 'test-root-key-material';
    const key = await blindIndexKey(root);
    expect(await blindIndexWith(key, 'email', 't1', 'sara@example.test')).toBe(
      await blindIndex(root, 'email', 't1', 'sara@example.test'),
    );
    const aes = await importPIIKey(root);
    expect(await decryptPII(await encryptPII('sara@example.test', aes), root)).toBe(
      'sara@example.test',
    );
  });
});
