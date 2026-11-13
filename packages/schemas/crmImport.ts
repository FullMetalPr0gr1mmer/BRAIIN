import { z } from 'zod';

// The CSV import of contacts (Admin v2 C15, crm.md §12). The request bodies of
// POST /api/admin/crm/contacts/import, strict, and the import's limits. The database checks
// them again (0139: the doors' limits and shapes, the columns' CHECKs).

/** At most this many people in one file (crm.md §12). */
export const IMPORT_MAX_ROWS = 5000;
/** At most this many bytes in one file: 2 MB as a computer shows it (2 MiB). */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
/**
 * At most this many people a request. The Workers Free plan gives a request 10 ms of CPU,
 * and a row costs about 40 to 60 µs (parse, checks, an encrypt and an index per e-mail and
 * phone), so 50 rows stay well inside it with the session and the database calls beside them.
 */
export const IMPORT_PIECE_ROWS = 50;
/** A piece's CSV text: 50 rows of the longest values allowed fit with room. */
export const IMPORT_PIECE_MAX_CHARS = 200_000;
/**
 * A piece's people as UTF-8 bytes (its heading row aside): the database's own cap
 * (crm_import_rows refuses a piece over 256 KiB). An Arabic letter is two bytes, so a piece
 * well under the character cap can pass this one; the screen cuts pieces under both.
 */
export const IMPORT_PIECE_MAX_BYTES = 256 * 1024;
/** The highest row number a file may name (the heading row is row 1). */
export const IMPORT_MAX_ROW_NUMBER = 100_000;
/** The lawful-basis statement the Admin confirms, by version (the screen's words). */
export const IMPORT_ATTESTATION = 'c15-v1';

/** The lawful bases a row may give (crm_contact_imports.basis). */
export const LAWFUL_BASES = [
  'consent',
  'contract',
  'legitimate_interest',
  'legal_obligation',
] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];

/** The columns an import reads, in the template's order. */
export const IMPORT_COLUMNS = [
  'name',
  'email',
  'phone',
  'company',
  'title',
  'city',
  'country',
  'language',
  'stage',
  'tags',
  'lawful_basis',
] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

/** Step 1: the Admin confirms the statement; the file's size and number of people. */
export const ImportOpenSchema = z
  .object({
    step: z.literal('open'),
    rows: z.number().int().min(1).max(IMPORT_MAX_ROWS),
    bytes: z.number().int().min(1).max(IMPORT_MAX_BYTES),
    attested: z.literal(true),
  })
  .strict();

/**
 * Step 2, as often as needed: a piece of the file as CSV text (its heading row first) and the
 * file's row number of each person in it, in order. The server parses the text itself.
 */
export const ImportRowsSchema = z
  .object({
    step: z.literal('rows'),
    batchId: z.string().uuid(),
    rowNumbers: z
      .array(z.number().int().min(2).max(IMPORT_MAX_ROW_NUMBER))
      .min(1)
      .max(IMPORT_PIECE_ROWS),
    csv: z.string().min(1).max(IMPORT_PIECE_MAX_CHARS),
  })
  .strict();

/** Step 3: close the import (done, or stopped by the Admin). */
export const ImportFinishSchema = z
  .object({
    step: z.literal('finish'),
    batchId: z.string().uuid(),
    stopped: z.boolean().optional(),
  })
  .strict();

export const ImportRequestSchema = z.discriminatedUnion('step', [
  ImportOpenSchema,
  ImportRowsSchema,
  ImportFinishSchema,
]);
export type ImportRequest = z.infer<typeof ImportRequestSchema>;
