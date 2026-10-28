import { isoOf, type Clock } from '@/lib/admin/relTime';

// The History drawer's rows (Admin v2 E1), from R10's `GET /api/admin/history` answers
// (src/lib/release/history.ts), pure so they are unit-tested (tests/lib/pageEditorModel.spec.ts).
// Names are the staff directory's; a person it does not list is "Someone".

interface Person {
  id: string;
  name: string | null;
}

/** One item's numbered saves (scope=item). */
export interface ItemHistory {
  enabled: boolean;
  live: boolean;
  restorable: boolean;
  pending: { scheduled: boolean } | null;
  versions: {
    seq: number;
    version: number;
    at: string;
    by: Person | null;
    release: { id: string; number: number | null } | null;
    live: boolean;
  }[];
  more: boolean;
}

/** The site versions that changed a page (scope=page). */
export interface PageHistory {
  enabled: boolean;
  restorable: boolean;
  versions: {
    id: string;
    number: number | null;
    kind: string;
    note: string | null;
    publishedAt: string | null;
    publishedBy: Person | null;
  }[];
  more: boolean;
}

export interface SaveRow {
  seq: number;
  /** "Save 3", and the site version it went live in once releases are on. */
  title: string;
  /** "Saved by Amal". */
  by: string;
  when: string;
  full: string;
  iso: string;
  live: boolean;
}

const who = (person: Person | null): string => person?.name?.trim() || 'Someone';

export function historyRows(history: ItemHistory, clock: Clock, now?: number): SaveRow[] {
  return history.versions.map((v) => ({
    seq: v.seq,
    title:
      v.release && v.release.number !== null
        ? `Save ${v.seq}, in v${v.release.number}`
        : `Save ${v.seq}`,
    by: `Saved by ${who(v.by)}`,
    when: clock.relTime(v.at, now),
    full: clock.formatDateTime(v.at),
    iso: isoOf(v.at),
    live: v.live,
  }));
}

export interface VersionRow {
  id: string;
  number: number | null;
  title: string;
  note: string | null;
  by: string;
  when: string;
  full: string;
  iso: string | null;
}

export function pageVersionRows(history: PageHistory, clock: Clock, now?: number): VersionRow[] {
  return history.versions.map((v) => ({
    id: v.id,
    number: v.number,
    title:
      (v.number !== null ? `v${v.number}` : 'A version') +
      (v.kind === 'rollback' ? ', a restore' : ''),
    note: v.note,
    by: `Published by ${who(v.publishedBy)}`,
    when: v.publishedAt ? clock.relTime(v.publishedAt, now) : '',
    full: v.publishedAt ? clock.formatDateTime(v.publishedAt) : '',
    iso: v.publishedAt ? isoOf(v.publishedAt) : null,
  }));
}
