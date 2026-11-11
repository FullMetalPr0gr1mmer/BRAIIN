import { z } from 'zod';

// CRM companies (Admin v2 C11, crm.md §5.3 and §9): the shapes the company routes accept. A
// module of its own beside crm.ts (the leads and contacts) and crmTasks.ts, so the lanes' edits
// never meet. The database checks the same rules again (the C11 migration: the column CHECKs,
// the composite keys, the owner rule in app.tg_crm_company_row, the allow-list in
// app.crm_company_body_ok): two layers, and a 22023, 23503 or 23514 for anything outside them.

/** A company's stage: the contacts' four (crm.md §5.3). */
export const COMPANY_STAGES = ['lead', 'client', 'past', 'partner'] as const;
export type CompanyStage = (typeof COMPANY_STAGES)[number];

/** How big it is (crm.md §5.3). */
export const COMPANY_SIZES = ['1-10', '11-50', '51-200', '200+'] as const;
export type CompanySize = (typeof COMPANY_SIZES)[number];

/** How the Companies tab sorts. */
export const COMPANY_SORTS = ['name', 'recent', 'contacts', 'value'] as const;

export const MAX_COMPANY_NAME = 120;
export const MAX_COMPANY_WEBSITE = 2048;
export const MAX_COMPANY_CITY = 80;
export const MAX_COMPANY_NOTES = 2000;

// No control characters in a one-line field; notes may hold line breaks and tabs.
// eslint-disable-next-line no-control-regex
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
// eslint-disable-next-line no-control-regex
const NOTE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

/**
 * A website: an https address, at most 2048 characters, with a host and no spaces (the
 * database's CHECK: `^https://[^[:space:]/?#@]+([/?#]…)?$`). No credentials in it.
 */
export const CompanyWebsiteSchema = z
  .string()
  .trim()
  .max(MAX_COMPANY_WEBSITE, `Keep the address to ${MAX_COMPANY_WEBSITE} characters.`)
  .regex(/^https:\/\/[^\s/?#@]+([/?#]\S*)?$/, 'Use an address that starts with https://')
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname.includes('.');
    } catch {
      return false;
    }
  }, 'Use an address that starts with https://');

const CompanyNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the company a name.')
  .max(MAX_COMPANY_NAME, `Keep the name to ${MAX_COMPANY_NAME} characters.`)
  .regex(NO_CONTROL, 'Use plain text.');
const CompanyCitySchema = z
  .string()
  .trim()
  .max(MAX_COMPANY_CITY, `Keep the city to ${MAX_COMPANY_CITY} characters.`)
  .regex(NO_CONTROL, 'Use plain text.');
const CompanyNotesSchema = z
  .string()
  .max(MAX_COMPANY_NOTES, `Keep the notes to ${MAX_COMPANY_NOTES} characters.`)
  .regex(NOTE_TEXT, 'Use plain text.');

/** The fields a person chooses. An empty text is sent as null (cleared). */
const companyFields = {
  name: CompanyNameSchema,
  website: CompanyWebsiteSchema.nullable(),
  sectorId: z.string().uuid().nullable(),
  clientId: z.string().uuid().nullable(),
  size: z.enum(COMPANY_SIZES).nullable(),
  city: CompanyCitySchema.nullable(),
  stage: z.enum(COMPANY_STAGES),
  ownerId: z.string().uuid().nullable(),
  notes: CompanyNotesSchema.nullable(),
};

/** POST /api/admin/crm/companies: a new company. */
export const CompanyCreateSchema = z
  .object({
    name: companyFields.name,
    website: companyFields.website.optional(),
    sectorId: companyFields.sectorId.optional(),
    clientId: companyFields.clientId.optional(),
    size: companyFields.size.optional(),
    city: companyFields.city.optional(),
    stage: companyFields.stage.optional(),
    ownerId: companyFields.ownerId.optional(),
    notes: companyFields.notes.optional(),
  })
  .strict();
export type CompanyCreate = z.infer<typeof CompanyCreateSchema>;

/** PATCH /api/admin/crm/companies/[id]: a change at the version read (explicit Save). */
export const CompanyPatchSchema = z
  .object({
    version: z.number().int().min(1),
    name: companyFields.name.optional(),
    website: companyFields.website.optional(),
    sectorId: companyFields.sectorId.optional(),
    clientId: companyFields.clientId.optional(),
    size: companyFields.size.optional(),
    city: companyFields.city.optional(),
    stage: companyFields.stage.optional(),
    ownerId: companyFields.ownerId.optional(),
    notes: companyFields.notes.optional(),
  })
  .strict()
  .refine(
    (patch) => Object.keys(patch).some((key) => key !== 'version'),
    'There is nothing to save.',
  );
export type CompanyPatch = z.infer<typeof CompanyPatchSchema>;

/** DELETE /api/admin/crm/companies/[id]: the version read. */
export const CompanyDeleteSchema = z.object({ version: z.number().int().min(1) }).strict();

/** POST /api/admin/crm/companies/query: the Companies tab's search, filters and page. */
export const CompanyQuerySchema = z
  .object({
    q: z.string().max(64).optional(),
    stage: z.enum(COMPANY_STAGES).optional(),
    owner: z.union([z.enum(['me', 'none']), z.string().uuid()]).optional(),
    sort: z.enum(COMPANY_SORTS).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(10000).optional(),
  })
  .strict();
export type CompanyQuery = z.infer<typeof CompanyQuerySchema>;

/**
 * POST /api/admin/crm/contacts/[id]/company: a contact's company at the contact's version.
 * `link` names a company; `create` is "Create company from this name" (the contact's own
 * free text, found or made); `unlink` keeps the last name as free text.
 */
export const ContactCompanySchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('link'),
      version: z.number().int().min(1),
      companyId: z.string().uuid(),
    })
    .strict(),
  z.object({ action: z.literal('create'), version: z.number().int().min(1) }).strict(),
  z.object({ action: z.literal('unlink'), version: z.number().int().min(1) }).strict(),
]);
export type ContactCompany = z.infer<typeof ContactCompanySchema>;
