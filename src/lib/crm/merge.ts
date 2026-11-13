import {
  DUPLICATE_REASONS,
  type DuplicatePair,
  type DuplicateReason,
  type DuplicateSide,
  type MergeOutcome,
} from '@schemas/crmMerge';
import { OptimisticLockError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { contactError } from './contacts';

// Merging duplicate contacts (Admin v2 C12, crm.md §5.5): the Worker's half. The rules live in
// the database (0138: the finder over blind indexes, "Not a duplicate", the merge door with
// its tombstone and its audit row in one transaction); this module cuts every answer to named
// safe fields (a pair carries who the two people are and counts, never an e-mail, a phone, an
// index or a note). Server only (it maps database errors); the screen's words are in
// mergeView.ts.

/** The fields of one person of a pair, in the order the screen reads them. */
export const DUPLICATE_SIDE_FIELDS = [
  'id',
  'display_name',
  'title',
  'company_name',
  'stage',
  'created_at',
  'last_activity_at',
  'version',
  'leads',
  'emails',
  'phones',
] as const satisfies readonly (keyof DuplicateSide)[];

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;

function side(value: unknown): DuplicateSide | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const id = str(row['id']);
  const name = str(row['display_name']);
  const version = row['version'];
  if (!id || name === null || typeof version !== 'number') return null;
  return {
    id,
    display_name: name,
    title: str(row['title']),
    company_name: str(row['company_name']),
    stage: str(row['stage']) ?? 'lead',
    created_at: str(row['created_at']) ?? '',
    last_activity_at: str(row['last_activity_at']) ?? '',
    version,
    leads: count(row['leads']),
    emails: count(row['emails']),
    phones: count(row['phones']),
  };
}

const isReason = (value: unknown): value is DuplicateReason =>
  typeof value === 'string' && (DUPLICATE_REASONS as readonly string[]).includes(value);

/**
 * public.crm_duplicate_pairs' answer, checked: each pair's named fields only, its reasons from
 * the closed list; anything else the database answered is dropped (so a later column can never
 * leak through this route).
 */
export function parseDuplicatePairs(data: unknown): DuplicatePair[] {
  if (!Array.isArray(data)) return [];
  const out: DuplicatePair[] = [];
  for (const raw of data as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const a = side(row['a']);
    const b = side(row['b']);
    const reasons = Array.isArray(row['reasons']) ? row['reasons'].filter(isReason) : [];
    if (!a || !b || reasons.length === 0) continue;
    out.push({ reasons, a, b });
  }
  return out;
}

/** public.crm_merge_contacts' answer, as the route answers it (counts only). */
export function parseMergeOutcome(data: unknown, keepId: string): MergeOutcome {
  const row = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const version = row['version'];
  return {
    keepId,
    version: typeof version === 'number' && Number.isInteger(version) ? version : 0,
    moved: {
      leads: count(row['leads']),
      channels: count(row['channels']),
      notes: count(row['notes']),
      tasks: count(row['tasks']),
    },
  };
}

interface DbError {
  code?: string;
  message?: string;
  details?: string | null;
}

/**
 * A refused merge or dismissal as the error the kernel maps: the contacts' own map (a 404, a
 * 409, a 422 naming the channel ceiling, a 403), plus a deadlock with an arrival or a channel
 * edit on the same address, which is a 409 too: nothing was merged, and trying again is safe.
 */
export function mergeError(error: DbError, what: string): Error {
  if (error.code === '40P01') return new OptimisticLockError('crm_contacts');
  // (Owner decision 2026-11-13) The door's own files rule (a file added after the route's
  // check): the same 403 the route gives, naming crm.files, so the dialog says "ask an Admin".
  if (error.code === '42501' && (error.message ?? '').includes('holds files')) {
    return new AuthorizationError('crm.files', `${what}: records holding files need an Admin`);
  }
  return contactError(error, what);
}
