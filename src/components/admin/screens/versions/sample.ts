import type { ReleaseStatusAnswer } from '@schemas/release';
import type { OpenRestore } from '@/lib/release/versionsPage';
import type { VersionsApi } from './api';
import type { VersionSummary } from './model';

// Made-up versions for the kit's gallery (/admin/kit, Admin v2 R13): the versions list and the
// dashboard's publish card as a CMS role meets them once releases are on, so the per-role sweep
// (axe, CSP, overflow at three widths) and tests/admin/backups.e2e.ts reach them before R14.
// No person's data, and an API that sends nothing.

const DAY = 86_400_000;
const at = (now: number, days: number) => new Date(now + days * DAY).toISOString();
const id = (n: number) => `5a5a5a5a-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = (n: number, name: string) => ({ id: id(900 + n), name });

const base: Omit<VersionSummary, 'id' | 'number' | 'live'> = {
  kind: 'publish',
  status: 'published',
  note: null,
  publishedAt: null,
  publishedBy: null,
  scheduledFor: null,
  scheduledBy: null,
  itemCount: 1,
  areas: ['pages'],
  restores: null,
  purge: 'skipped',
  failure: null,
  version: 1,
};

export interface SampleVersions {
  versions: VersionSummary[];
  upcoming: VersionSummary[];
  restores: Record<string, OpenRestore>;
}

export function sampleVersions(now: number): SampleVersions {
  return {
    upcoming: [
      {
        ...base,
        id: id(10),
        number: null,
        live: false,
        status: 'scheduled',
        scheduledFor: at(now, 2),
        scheduledBy: person(1, 'Sample Editor'),
        itemCount: 3,
        areas: ['services', 'our_work'],
        purge: 'pending',
        version: 2,
      },
      {
        ...base,
        id: id(11),
        number: null,
        live: false,
        status: 'failed',
        scheduledFor: at(now, -1),
        scheduledBy: person(2, 'Sample Publisher'),
        purge: 'pending',
        failure: 'conflict',
      },
    ],
    versions: [
      {
        ...base,
        id: id(3),
        number: 3,
        live: true,
        note: 'Spring copy on the home page',
        publishedAt: at(now, -0.2),
        publishedBy: person(2, 'Sample Publisher'),
        itemCount: 4,
        areas: ['pages', 'services'],
        purge: 'failed',
      },
      {
        ...base,
        id: id(2),
        number: 2,
        live: false,
        publishedAt: at(now, -3),
        publishedBy: person(1, 'Sample Editor'),
        itemCount: 2,
        areas: ['our_work'],
      },
      {
        ...base,
        id: id(1),
        number: 1,
        live: false,
        kind: 'baseline',
        publishedAt: at(now, -10),
        itemCount: 0,
        areas: [],
        purge: 'not_needed',
      },
    ],
    // v2 was restored, and waits to be published as its rollback.
    restores: {
      [id(2)]: {
        items: [
          { draftId: id(21), draftVersion: 2 },
          { draftId: id(22), draftVersion: 2 },
        ],
        untouched: true,
      },
    },
  };
}

/** The publish card's made-up status, as releases-on would answer it for a publisher. */
export function sampleStatus(now: number): ReleaseStatusAnswer {
  return {
    enabled: true,
    live: {
      id: id(3),
      number: 3,
      publishedAt: at(now, -0.2),
      publishedBy: person(2, 'Sample Publisher'),
      note: 'Spring copy on the home page',
      purge: 'failed',
    },
    pending: { publishable: 2, waiting: 1, scheduled: 3 },
    next: { id: id(10), scheduledFor: at(now, 2), changes: 3, total: 1 },
    failed: 1,
    cacheConnected: true,
    maintenance: false,
  };
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 120));

/** Answers as the routes would, sending nothing. */
export const SAMPLE_VERSIONS_API: VersionsApi = {
  restore: async (releaseId) => {
    await wait();
    return {
      release: { id: releaseId, number: 1 },
      scope: 'site',
      staged: [
        {
          draftId: id(31),
          draftVersion: 2,
          entityType: 'page',
          entityId: id(41),
          op: 'update',
          label: { en: 'Home', ar: 'الرئيسية' },
        },
      ],
      kept: [],
      marked: true,
    };
  },
  publishRollback: async () => {
    await wait();
    return { release: { id: id(4), number: 4 }, items: [], warnings: [], purge: 'skipped' };
  },
  reschedule: async (releaseId, version, scheduleAt) => {
    await wait();
    return { release: { id: releaseId, scheduledFor: scheduleAt, version: version + 1 } };
  },
  unschedule: async () => {
    await wait();
    return {};
  },
  retryPurge: async (releaseId) => {
    await wait();
    return { release: { id: releaseId, number: 3 }, purge: 'done', autoRetry: false };
  },
};
