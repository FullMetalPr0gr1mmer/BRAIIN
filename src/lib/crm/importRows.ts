import type { SupabaseClient } from '@supabase/supabase-js';
import {
  IMPORT_PIECE_ROWS,
  LAWFUL_BASES,
  type ImportColumn,
  type LawfulBasis,
} from '@schemas/crmImport';
import { CONTACT_STAGES, type ContactStage } from '@schemas/crm';
import type { AuthContext } from '@/lib/auth/types';
import { AuthorizationError } from '@/lib/authz/errors';
import { NotFoundError, ValidationError } from '@/lib/admin/errors';
import { importPIIKey, encryptPII } from '@/lib/crypto/pii';
import { blindIndexKey, blindIndexWith } from './blindIndex';
import { normalizeEmail, normalizePhone } from './normalize';
import {
  isBlankRecord,
  mapHeadings,
  parseCsv,
  recordValues,
  utf8Length,
  type CsvProblem,
  type HeadingProblem,
} from './importCsv';

// The CSV import's server half (Admin v2 C15): one piece of a file, parsed here (never the
// browser's reading), each row checked, its e-mail and phone encrypted and blind-indexed with
// keys made once a request, then public.crm_import_rows as the service role (which checks the
// acting profile live, dedupes by the indexes and keeps the batch's totals). What leaves is
// row numbers and codes: never a cell, so nothing a person typed reaches an answer, a log line
// or an audit row.

/** Why one row was not imported (the screen says each in words). */
export const ROW_PROBLEMS = [
  'name_missing',
  'name',
  'email',
  'phone',
  'no_contact',
  'basis_missing',
  'basis',
  'stage',
  'language',
  'country',
  'tags',
  'company',
  'title',
  'city',
  'columns',
  'refused',
] as const;
export type RowProblem = (typeof ROW_PROBLEMS)[number];

const CONTROL = /[\u0000-\u001f\u007f]/;

function fold(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-]+/g, ' ');
}

const BASIS_WORDS: ReadonlyMap<string, LawfulBasis> = new Map([
  ...LAWFUL_BASES.map((b) => [fold(b), b] as const),
  ['موافقة', 'consent'],
  ['الموافقة', 'consent'],
  ['عقد', 'contract'],
  ['العقد', 'contract'],
  ['مصلحة مشروعة', 'legitimate_interest'],
  ['المصلحة المشروعة', 'legitimate_interest'],
  ['التزام نظامي', 'legal_obligation'],
  ['الالتزام النظامي', 'legal_obligation'],
]);

const STAGE_WORDS: ReadonlyMap<string, ContactStage> = new Map([
  ...CONTACT_STAGES.map((s) => [s, s] as const),
  ['past client', 'past'],
  ['عميل محتمل', 'lead'],
  ['عميل', 'client'],
  ['عميل سابق', 'past'],
  ['شريك', 'partner'],
]);

const LANGUAGE_WORDS: ReadonlyMap<string, 'en' | 'ar'> = new Map([
  ['en', 'en'],
  ['english', 'en'],
  ['الإنجليزية', 'en'],
  ['انجليزي', 'en'],
  ['ar', 'ar'],
  ['arabic', 'ar'],
  ['العربية', 'ar'],
  ['عربي', 'ar'],
]);

/** A row the checks passed, before its e-mail and phone are sealed. */
export interface CheckedRow {
  row: number;
  basis: LawfulBasis;
  displayName: string;
  title?: string;
  companyName?: string;
  stage?: ContactStage;
  locale?: 'en' | 'ar';
  city?: string;
  country?: string;
  tags: string[];
  email?: { value: string; normalized: string };
  phone?: { value: string; raw: string };
}

type TextCheck = { ok: true; value: string | undefined } | { ok: false };

/** An optional text cell: trimmed, at most `max`, no control characters; empty is absent. */
function optionalText(raw: string | undefined, max: number): TextCheck {
  const value = (raw ?? '').trim();
  if (value === '') return { ok: true, value: undefined };
  if (value.length > max || CONTROL.test(value)) return { ok: false };
  return { ok: true, value };
}

/**
 * Checks one record against the import's rules. The phone's normalisation needs the
 * tenant's country when the row names none, so it is finished in sealRows.
 */
export function checkRow(
  row: number,
  values: Partial<Record<ImportColumn, string>>,
): { ok: true; row: CheckedRow } | { ok: false; row: number; problem: RowProblem } {
  const fail = (problem: RowProblem) => ({ ok: false as const, row, problem });
  const name = (values.name ?? '').trim();
  if (name === '') return fail('name_missing');
  if (name.length > 120 || CONTROL.test(name)) return fail('name');

  const basisRaw = (values.lawful_basis ?? '').trim();
  if (basisRaw === '') return fail('basis_missing');
  const basis = BASIS_WORDS.get(fold(basisRaw));
  if (!basis) return fail('basis');

  const emailRaw = (values.email ?? '').trim();
  const phoneRaw = (values.phone ?? '').trim();
  if (emailRaw === '' && phoneRaw === '') return fail('no_contact');
  let email: CheckedRow['email'];
  if (emailRaw !== '') {
    const normalized =
      emailRaw.length <= 254 && !CONTROL.test(emailRaw) ? normalizeEmail(emailRaw) : null;
    if (!normalized) return fail('email');
    email = { value: emailRaw, normalized };
  }
  if (phoneRaw !== '' && (phoneRaw.length < 3 || phoneRaw.length > 32 || CONTROL.test(phoneRaw))) {
    return fail('phone');
  }

  const company = optionalText(values.company, 120);
  if (!company.ok) return fail('company');
  const title = optionalText(values.title, 120);
  if (!title.ok) return fail('title');
  const city = optionalText(values.city, 80);
  if (!city.ok) return fail('city');

  let country: string | undefined;
  const countryRaw = (values.country ?? '').trim();
  if (countryRaw !== '') {
    country = countryRaw.toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) return fail('country');
  }
  let stage: ContactStage | undefined;
  const stageRaw = (values.stage ?? '').trim();
  if (stageRaw !== '') {
    stage = STAGE_WORDS.get(fold(stageRaw));
    if (!stage) return fail('stage');
  }
  let locale: 'en' | 'ar' | undefined;
  const languageRaw = (values.language ?? '').trim();
  if (languageRaw !== '') {
    locale = LANGUAGE_WORDS.get(fold(languageRaw));
    if (!locale) return fail('language');
  }

  const tags: string[] = [];
  for (const part of (values.tags ?? '').split(/[;|]/)) {
    const tag = part.trim();
    if (tag === '' || tags.includes(tag)) continue;
    if (tag.length > 32 || CONTROL.test(tag)) return fail('tags');
    tags.push(tag);
  }
  if (tags.length > 10) return fail('tags');

  return {
    ok: true,
    row: {
      row,
      basis,
      displayName: name,
      ...(title.value ? { title: title.value } : {}),
      ...(company.value ? { companyName: company.value } : {}),
      ...(stage ? { stage } : {}),
      ...(locale ? { locale } : {}),
      ...(city.value ? { city: city.value } : {}),
      ...(country ? { country } : {}),
      tags,
      ...(email ? { email } : {}),
      ...(phoneRaw !== '' ? { phone: { value: phoneRaw, raw: phoneRaw } } : {}),
    },
  };
}

/** A row as public.crm_import_rows takes it: ciphertext and indexes, never a plain value. */
export interface SealedRow {
  row: number;
  basis: LawfulBasis;
  display_name: string;
  title?: string;
  company_name?: string;
  stage?: ContactStage;
  locale?: 'en' | 'ar';
  city?: string;
  country?: string;
  tags: string[];
  channels: { kind: 'email' | 'phone'; value_enc: string; value_hmac: string }[];
}

/**
 * Encrypts and indexes each row's e-mail and phone, the keys made once. A phone that cannot
 * be read as a number (in the row's country, else the tenant's) refuses its row: an import is
 * deduped by its indexes, so a phone with no index could make the same person twice.
 */
export async function sealRows(
  rootKey: string,
  tenantId: string,
  rows: readonly CheckedRow[],
  tenantCountry: () => Promise<string>,
): Promise<{ sealed: SealedRow[]; refused: { row: number; problem: RowProblem }[] }> {
  const sealed: SealedRow[] = [];
  const refused: { row: number; problem: RowProblem }[] = [];
  if (rows.length === 0) return { sealed, refused };
  const [aesKey, indexKey] = await Promise.all([importPIIKey(rootKey), blindIndexKey(rootKey)]);
  let homeCountry: string | null = null;
  for (const row of rows) {
    const channels: SealedRow['channels'] = [];
    if (row.phone) {
      const country = row.country ?? (homeCountry ??= await tenantCountry());
      const normalized = normalizePhone(row.phone.raw, country);
      if (!normalized) {
        refused.push({ row: row.row, problem: 'phone' });
        continue;
      }
      if (row.email) {
        channels.push({
          kind: 'email',
          value_enc: await encryptPII(row.email.value, aesKey),
          value_hmac: await blindIndexWith(indexKey, 'email', tenantId, row.email.normalized),
        });
      }
      channels.push({
        kind: 'phone',
        value_enc: await encryptPII(row.phone.value, aesKey),
        value_hmac: await blindIndexWith(indexKey, 'phone', tenantId, normalized),
      });
    } else if (row.email) {
      channels.push({
        kind: 'email',
        value_enc: await encryptPII(row.email.value, aesKey),
        value_hmac: await blindIndexWith(indexKey, 'email', tenantId, row.email.normalized),
      });
    }
    sealed.push({
      row: row.row,
      basis: row.basis,
      display_name: row.displayName,
      ...(row.title ? { title: row.title } : {}),
      ...(row.companyName ? { company_name: row.companyName } : {}),
      ...(row.stage ? { stage: row.stage } : {}),
      ...(row.locale ? { locale: row.locale } : {}),
      ...(row.city ? { city: row.city } : {}),
      ...(row.country ? { country: row.country } : {}),
      tags: row.tags,
      channels,
    });
  }
  return { sealed, refused };
}

/** The words for a file or piece that cannot be read (column and row numbers only). */
export function fileProblemMessage(
  problem: CsvProblem | HeadingProblem | 'rows_mismatch',
  at?: number,
): string {
  switch (problem) {
    case 'empty':
      return 'The file is empty.';
    case 'binary':
      return 'This is not a text file. Save the spreadsheet as CSV UTF-8 and try again.';
    case 'unclosed_quote':
      return `A quotation mark is never closed, from row ${at ?? 1} on.`;
    case 'too_many_columns':
      return `Row ${at ?? 1} has more than 32 columns.`;
    case 'cell_too_long':
      return `Row ${at ?? 1} has a cell longer than 2,000 characters.`;
    case 'too_many_rows':
      return 'The file has too many rows. Import at most 5,000 people at a time.';
    case 'heading_twice':
      return `Column ${at ?? 1} repeats a heading another column already uses.`;
    case 'no_name':
      return 'The file has no name column. Use the template’s headings.';
    case 'no_basis':
      return 'The file has no lawful_basis column. Every person needs one.';
    case 'no_contact_column':
      return 'The file has no email or phone column. We need one to tell people apart.';
    case 'rows_mismatch':
      return 'This part of the file did not arrive as it was sent. Try the import again.';
  }
}

export interface PieceOutcome {
  created: number;
  duplicates: number[];
  repeats: { row: number; of: number }[];
  phoneMatches: number[];
  problems: { row: number; problem: RowProblem }[];
}

const ints = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.filter((v): v is number => typeof v === 'number' && Number.isInteger(v))
    : [];

/** What the door answered, cut to numbers (anything else it returned is dropped). */
export function pieceOutcome(
  data: unknown,
  problems: { row: number; problem: RowProblem }[],
): PieceOutcome {
  const answer = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const repeats = Array.isArray(answer['repeats'])
    ? (answer['repeats'] as unknown[]).flatMap((r) => {
        const item = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
        return typeof item['row'] === 'number' && typeof item['of'] === 'number'
          ? [{ row: item['row'], of: item['of'] }]
          : [];
      })
    : [];
  const refused = ints(answer['refused']).map((row) => ({ row, problem: 'refused' as const }));
  return {
    created: typeof answer['created'] === 'number' ? answer['created'] : 0,
    duplicates: ints(answer['duplicates']),
    repeats,
    phoneMatches: ints(answer['phone_matches']),
    problems: [...problems, ...refused].sort((a, b) => a.row - b.row),
  };
}

/** Maps a door's refusal to the status the kernel answers (never its text). */
export function importError(error: { code?: string }): Error {
  switch (error.code) {
    case 'P0002':
      return new NotFoundError('import');
    case '42501':
      return new AuthorizationError('crm.import', 'refused by the database');
    case '54000':
      return new ValidationError(
        'This import is over its limits: at most 5,000 people and 2 MB a file.',
      );
    case '22023':
      return new ValidationError('The import could not read what was sent. Try again.');
    default:
      return new Error(`crm import: ${error.code ?? 'no code'}`);
  }
}

/**
 * One piece: parse, check, seal, then the door. `rowNumbers` are the file's row numbers of the
 * piece's people, in order (the browser's numbering: it can mislabel only its own report).
 */
export async function importPiece(opts: {
  auth: AuthContext;
  svc: SupabaseClient;
  rootKey: string;
  batchId: string;
  rowNumbers: readonly number[];
  csv: string;
  tenantCountry: () => Promise<string>;
}): Promise<PieceOutcome> {
  const parsed = parseCsv(opts.csv, {
    maxRecords: IMPORT_PIECE_ROWS * 4 + 1,
    maxColumns: 32,
    maxCellLength: 2000,
  });
  if (!parsed.ok) throw new ValidationError(fileProblemMessage(parsed.problem, parsed.row));
  const [headings = [], ...rest] = parsed.records;
  const mapped = mapHeadings(headings);
  if (!mapped.ok) throw new ValidationError(fileProblemMessage(mapped.problem, mapped.column));
  const people = rest.filter((record) => !isBlankRecord(record));
  if (people.length !== opts.rowNumbers.length) {
    throw new ValidationError(fileProblemMessage('rows_mismatch'));
  }

  const problems: { row: number; problem: RowProblem }[] = [];
  const checked: CheckedRow[] = [];
  people.forEach((record, index) => {
    const row = opts.rowNumbers[index] as number;
    if (record.length > headings.length) {
      problems.push({ row, problem: 'columns' });
      return;
    }
    const result = checkRow(row, recordValues(record, mapped.columns));
    if (result.ok) checked.push(result.row);
    else problems.push({ row: result.row, problem: result.problem });
  });
  const { sealed, refused } = await sealRows(
    opts.rootKey,
    opts.auth.tenantId,
    checked,
    opts.tenantCountry,
  );
  problems.push(...refused);

  // The piece's people, as bytes (the heading row is the import's own, not the file's).
  const headingLength = utf8Length(opts.csv.slice(0, opts.csv.search(/\r?\n/) + 1));
  const bytes = Math.max(1, utf8Length(opts.csv) - headingLength);
  const { data, error } = await opts.svc.rpc('crm_import_rows', {
    p_tenant: opts.auth.tenantId,
    p_batch: opts.batchId,
    p_actor: opts.auth.userId,
    p_rows: sealed,
    p_failed: problems.length,
    p_bytes: bytes,
  });
  if (error) throw importError(error as { code?: string });
  return pieceOutcome(data, problems);
}
