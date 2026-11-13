import { z } from 'zod';

// Merging duplicate contacts (Admin v2 C12, crm.md §5.5 and §9): the shapes the merge routes
// accept and the finder's answer. A module of its own beside crm.ts and crmTasks.ts, so the
// parallel CRM lanes' edits never meet. The database checks the same rules again (0138: the
// finder's bound, the dismissal's two different people, the merge's versions and its tenant
// fence): two layers, and a 22023, P0002 or 40001 for anything outside them.

/** Why a pair was offered (app.crm_duplicate_candidates): never a value, a rule's name. */
export const DUPLICATE_REASONS = ['phone', 'name_company'] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

/** The most pairs the finder answers in one read (crm.md §9). */
export const DUPLICATE_PAIR_LIMIT = 50;

/** POST /api/admin/crm/duplicates/dismiss: "Not a duplicate", for one pair. */
export const DuplicateDismissSchema = z
  .object({ a: z.string().uuid(), b: z.string().uuid() })
  .strict()
  .refine((body) => body.a !== body.b, {
    message: 'A person is not their own duplicate.',
    path: ['b'],
  });
export type DuplicateDismiss = z.infer<typeof DuplicateDismissSchema>;

const VersionSchema = z.number().int().min(1).max(999_999_999);

/**
 * POST /api/admin/crm/contacts/merge: the record kept and the one merged into it, each with the
 * version the screen read (a 409 when either moved on).
 */
export const ContactMergeSchema = z
  .object({
    keepId: z.string().uuid(),
    keepVersion: VersionSchema,
    dropId: z.string().uuid(),
    dropVersion: VersionSchema,
  })
  .strict()
  .refine((body) => body.keepId !== body.dropId, {
    message: 'Pick two different people.',
    path: ['dropId'],
  });
export type ContactMerge = z.infer<typeof ContactMergeSchema>;

/** One person of a pair, as the finder draws them: who they are and counts, never a value. */
export const DuplicateSideSchema = z
  .object({
    id: z.string().uuid(),
    display_name: z.string(),
    title: z.string().nullable(),
    company_name: z.string().nullable(),
    stage: z.string(),
    created_at: z.string(),
    last_activity_at: z.string(),
    version: z.number().int(),
    leads: z.number().int().min(0),
    emails: z.number().int().min(0),
    phones: z.number().int().min(0),
  })
  .strict();
export type DuplicateSide = z.infer<typeof DuplicateSideSchema>;

/** One likely duplicate: the reasons, and the two people. */
export const DuplicatePairSchema = z
  .object({
    reasons: z.array(z.enum(DUPLICATE_REASONS)).min(1),
    a: DuplicateSideSchema,
    b: DuplicateSideSchema,
  })
  .strict();
export type DuplicatePair = z.infer<typeof DuplicatePairSchema>;

/** What a merge moved, as the route answers it (counts only). */
export interface MergeOutcome {
  keepId: string;
  version: number;
  moved: { leads: number; channels: number; notes: number; tasks: number };
}
