import {
  APPLICATION_STATUSES,
  AVAILABILITY,
  EXPERIENCE_LEVELS,
  WORK_TYPES,
  optionLabel,
  type ApplicationStatus,
} from '@schemas/application';
import type { Clock } from './relTime';
import type { BadgeTone } from './tones';

// The job applications screen's words and rules (Admin v2 U8a), pure so the panel, the drawer
// and the tests share them. Browser code (the admin-ui chunk): no Zod schema of its own,
// only the option tables and the status list the Join schema owns.
//
// What the screen shows of an application is what the API sends (src/lib/admin/
// applicationFields.ts): the list and the detail never carry the contact details or the CV's
// storage path. The contact details arrive only from the audited reveal (`?pii=1`), and
// stay in the drawer's memory: `mergeAfterPatch` keeps them when a status or notes save
// answers with the row, so a save never asks the server to decrypt (and audit) again.

export interface ApplicationRow {
  id: string;
  created_at: string;
  locale: string;
  name: string;
  city: string;
  role: string;
  experience: string;
  work_type: string;
  availability: string;
  skills: string[];
  portfolio_url: string;
  linkedin_url: string | null;
  status: string;
  future_roles_consent: boolean;
  retention_delete_after: string;
  has_cv: boolean;
  cv_content_type: string | null;
  cv_bytes: number | null;
}

export interface ApplicationDetail extends ApplicationRow {
  message: string;
  internal_notes: string | null;
  consent_at: string;
  consent_version: string;
  /** Present only after the audited reveal; null when the applicant gave none. */
  email?: string | null;
  phone?: string | null;
}

/** The words a status shows (never the stored key with an underscore). */
export const APPLICATION_STATUS_LABEL: Readonly<Record<ApplicationStatus, string>> = {
  new: 'New',
  in_review: 'In review',
  shortlisted: 'Shortlisted',
  declined: 'Declined',
  hired: 'Hired',
  spam: 'Spam',
};

/** The tone of a status badge (admin.css `.badge[data-tone]`; the word carries the state). */
export const APPLICATION_STATUS_TONE: Readonly<Record<ApplicationStatus, BadgeTone>> = {
  new: 'klein',
  in_review: 'sky',
  shortlisted: 'ok',
  declined: 'gray',
  hired: 'ok',
  spam: 'err',
};

export const isApplicationStatus = (value: unknown): value is ApplicationStatus =>
  typeof value === 'string' && (APPLICATION_STATUSES as readonly string[]).includes(value);

/** A status's words; an unknown stored value (a hand-edited row) shows as itself. */
export function statusLabel(status: string): string {
  return isApplicationStatus(status) ? APPLICATION_STATUS_LABEL[status] : status;
}

export function statusTone(status: string): BadgeTone {
  return isApplicationStatus(status) ? APPLICATION_STATUS_TONE[status] : 'gray';
}

export type StatusChip = ApplicationStatus | 'all';

/** The list's filter: All, then every status in the Join schema's order. */
export function statusChips(): { value: StatusChip; label: string }[] {
  return [
    { value: 'all', label: 'All' },
    ...APPLICATION_STATUSES.map((value) => ({ value, label: APPLICATION_STATUS_LABEL[value] })),
  ];
}

/**
 * The "Details" card: label and value pairs, from the option tables (labels, never keys).
 * Never a contact field: the e-mail and phone have their own card, behind the reveal.
 * "Received" is in the studio's zone: the caller's clock (Admin v2 U9, relTime.ts).
 */
export function detailRows(detail: ApplicationRow, clock: Clock): [string, string][] {
  return [
    ['Role', detail.role],
    ['City', detail.city],
    ['Experience', optionLabel(EXPERIENCE_LEVELS, detail.experience)],
    ['Works', optionLabel(WORK_TYPES, detail.work_type)],
    ['Can start', optionLabel(AVAILABILITY, detail.availability)],
    ['Language', detail.locale === 'ar' ? 'Arabic' : 'English'],
    ['Received', clock.formatDateTime(detail.created_at)],
  ];
}

/**
 * The drawer's application after a status or notes save: the PATCH answers with the row's
 * detail columns (the new status, its retention horizon, the notes) and never with contact
 * details, so the e-mail and phone already revealed are kept as they are. A reveal is one
 * audited read; a save after it must not need another.
 */
export function mergeAfterPatch(
  current: ApplicationDetail,
  patched: Partial<ApplicationDetail>,
): ApplicationDetail {
  const { email: _email, phone: _phone, ...answer } = patched;
  const next: ApplicationDetail = { ...current, ...answer };
  if ('email' in current) next.email = current.email ?? null;
  if ('phone' in current) next.phone = current.phone ?? null;
  return next;
}

// The drawer's requests belong to the application they were sent for. The drawer stays
// mounted while it moves from one application to another (closed and reopened, or opened
// from the list or the bell), so a request may still be on its way when another
// application is on screen. Its answer and its end touch only its own application: a slow
// save for A never turns B's drawer into A's (with B's unsaved notes ready to be written
// into A), and neither a request for A nor a finished erase leaves B's controls disabled.

/**
 * A status or notes save's answer, laid over the drawer's application only when that is
 * the one the save was for (`forId`); any other application is returned as it is.
 */
export function afterPatch(
  current: ApplicationDetail | null,
  forId: string,
  answer: Partial<ApplicationDetail>,
): ApplicationDetail | null {
  return current !== null && current.id === forId ? mergeAfterPatch(current, answer) : current;
}

/** The reveal's answer, likewise: it replaces only the application it was read for. */
export function afterReveal(
  current: ApplicationDetail | null,
  row: ApplicationDetail,
): ApplicationDetail | null {
  return current !== null && current.id === row.id ? row : current;
}

/**
 * The application a drawer request is on its way for (`pending`): the controls are off
 * only while that is the application on screen (`shown`).
 */
export const isBusyFor = (pending: string | null, shown: string | null): boolean =>
  pending !== null && pending === shown;

/**
 * A request for `forId` has ended (answered, refused, or an erase done): the mark is
 * cleared only if it is still that request's, so a later request for another application
 * keeps its own.
 */
export const settled = (pending: string | null, forId: string): string | null =>
  pending === forId ? null : pending;

/** True once the contact details have been revealed into this application. */
export const isRevealed = (detail: ApplicationDetail | null): boolean =>
  detail !== null && ('email' in detail || 'phone' in detail);

/** The application with its contact details dropped from memory ("Hide"). */
export function withoutContact(detail: ApplicationDetail): ApplicationDetail {
  const { email: _email, phone: _phone, ...rest } = detail;
  return rest;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The address's `?status=` and `?open=`, read on the server for the first paint: a status
 * the Join schema knows, else none; an id shaped as a uuid, else none. Anything else is
 * ignored, never echoed into the page.
 */
export function parseInitial(query: { status?: string | null; open?: string | null }): {
  status: ApplicationStatus | null;
  open: string | null;
} {
  const status = isApplicationStatus(query.status) ? query.status : null;
  const open = typeof query.open === 'string' && UUID.test(query.open) ? query.open : null;
  return { status, open: open ? open.toLowerCase() : null };
}

/** `1.2 MB` / `850 KB`. */
export function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return '';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** A link the admin may open: https only (the schema and the 0029 CHECK already insist). */
export function safeLink(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null;
}
