import type { Role } from '@/lib/auth/types';
import { canPublish, requiredCaps, waitingFor, type ReleaseItemRef } from '@/lib/release/caps';
import type {
  CompareResult,
  DraftOp,
  PendingItem,
  PublishResult,
  ReleaseArea,
  ReleaseCheck,
  ReleaseCheckItem,
  ReleaseEntityType,
} from '@schemas/release';
import type { PublishSelection, ReleaseApi } from './api';
import type { PendingSummary } from './model';

// The kit gallery's publishing seam (Admin v2 R12, /admin/kit): the savebar and the publish
// dialog over made-up changes, so the per-role sweep (axe, CSP, overflow) and
// tests/admin/releases-ui.e2e.ts exercise them in a browser while releases are off. Nothing is
// sent: every answer is computed here, who may publish what from ROLE_CAPS (src/lib/release/
// caps.ts), as the server computes it. The changes are plain samples, no person's data.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-10-23T08:00:00Z';

interface Sample {
  n: number;
  entityType: ReleaseEntityType;
  area: ReleaseArea;
  op: DraftOp;
  label: { en: string; ar?: string } | null;
  fieldLabels: string[];
  fields: string[];
  status?: string | null;
  by: string;
  mine: boolean;
}

const SAMPLES: readonly Sample[] = [
  {
    n: 1,
    entityType: 'page_section',
    area: 'pages',
    op: 'update',
    label: { en: 'Home: the hero', ar: 'الرئيسية: الواجهة' },
    fieldLabels: ['Headline', 'Line under it'],
    fields: ['content'],
    by: 'Sample editor',
    mine: true,
  },
  {
    n: 2,
    entityType: 'service',
    area: 'services',
    op: 'update',
    label: { en: 'Logo Design', ar: 'تصميم الشعار' },
    fieldLabels: ['Service name', 'Tagline', 'Intro', 'Poster'],
    fields: ['title', 'blurb', 'intro', 'poster_media_id'],
    status: 'published',
    by: 'Sample writer',
    mine: false,
  },
  ...[3, 4, 5].map((n): Sample => ({
    n,
    entityType: 'service',
    area: 'services',
    op: 'update',
    label: { en: `Service ${n}` },
    fieldLabels: ['Sort order'],
    fields: ['sort_order'],
    by: 'Sample editor',
    mine: true,
  })),
  {
    n: 6,
    entityType: 'client',
    area: 'our_work',
    op: 'create',
    label: { en: 'Sample Client', ar: 'عميل تجريبي' },
    fieldLabels: ['Name', 'Logo'],
    fields: ['name', 'logo_media_id'],
    by: 'Sample editor',
    mine: true,
  },
  {
    n: 7,
    entityType: 'portfolio',
    area: 'our_work',
    op: 'create',
    label: { en: 'Sample Project', ar: 'مشروع تجريبي' },
    fieldLabels: ['Title', 'Client', 'Hero'],
    fields: ['title', 'client_id', 'hero_media_id'],
    status: 'published',
    by: 'Sample editor',
    mine: true,
  },
  {
    n: 8,
    entityType: 'testimonial',
    area: 'our_work',
    op: 'update',
    label: { en: 'A sample quote' },
    fieldLabels: ['Status'],
    fields: ['status'],
    status: 'archived',
    by: 'Sample editor',
    mine: false,
  },
  {
    n: 9,
    entityType: 'entity_seo',
    area: 'seo',
    op: 'update',
    label: { en: 'Search settings: Logo Design' },
    fieldLabels: ['Meta title'],
    fields: ['meta_title'],
    by: 'Sample writer',
    mine: false,
  },
  {
    n: 10,
    entityType: 'site_profile',
    area: 'settings',
    op: 'update',
    label: { en: 'Site identity' },
    fieldLabels: ['Tagline'],
    fields: ['tagline'],
    by: 'Sample writer',
    mine: false,
  },
];

/** The project (7) needs the new client (6): the dependency the dialog ticks for you. */
const NEEDS: Readonly<Record<number, number>> = { 7: 6 };
/** The hero (1) is the one the live site moved under: the conflict and its Compare. */
const CONFLICTED = 1;
/** Logo Design (2) stays hidden until its discipline is published: a warning. */
const WARNED = 2;

function itemOf(sample: Sample, role: Role, version: number): PendingItem {
  const ref: ReleaseItemRef = {
    entityType: sample.entityType,
    op: sample.op,
    patch: sample.status ? { status: sample.status } : null,
  };
  const caps = requiredCaps(ref);
  return {
    draftId: id(sample.n),
    draftVersion: version,
    entityType: sample.entityType,
    entityId: id(100 + sample.n),
    op: sample.op,
    area: sample.area,
    label: sample.label,
    fields: sample.fields,
    updatedBy: null,
    updatedByName: sample.by,
    updatedAt: AT,
    scheduled: false,
    mine: sample.mine,
    publishableByMe: canPublish(role, ref),
    requiredCaps: caps ? [...caps] : null,
    waitingFor: waitingFor(ref),
    status: sample.status ?? null,
    visible: null,
    href: null,
    fieldLabels: sample.fieldLabels,
  };
}

/** A made-up seam over the samples, as the given role sees them. */
export function sampleReleaseApi(role: Role): ReleaseApi {
  let open = new Set(SAMPLES.map((s) => s.n));
  const versions = new Map<number, number>(SAMPLES.map((s) => [s.n, 1]));
  let conflicted = true;
  let number = 14;
  const byDraft = (draftId: string) => SAMPLES.find((s) => id(s.n) === draftId);
  const settle = <T>(value: T) => new Promise<T>((done) => setTimeout(() => done(value), 120));

  const check = (selection: PublishSelection): ReleaseCheck => {
    const chosen = new Set(selection.items.map((i) => i.draftId));
    const items: ReleaseCheckItem[] = selection.items.flatMap((ref) => {
      const sample = byDraft(ref.draftId);
      if (!sample) return [];
      const item = itemOf(sample, role, versions.get(sample.n) ?? 1);
      const needed = NEEDS[sample.n];
      const missing = needed !== undefined && !chosen.has(id(needed));
      const conflict = sample.n === CONFLICTED && conflicted;
      return [
        {
          draftId: item.draftId,
          draftVersion: item.draftVersion,
          entityType: item.entityType,
          entityId: item.entityId,
          op: item.op,
          area: item.area,
          label: item.label,
          errors: [
            ...(missing
              ? [
                  {
                    code: 'requires' as const,
                    message: 'It points at a new item that is not ticked.',
                  },
                ]
              : []),
            ...(conflict
              ? [{ code: 'conflict' as const, message: 'Changed on the live site.' }]
              : []),
          ],
          warnings:
            sample.n === WARNED
              ? [
                  {
                    code: 'hidden-by-discipline' as const,
                    message: 'It stays hidden on the site: its discipline is not published.',
                  },
                ]
              : [],
          requires:
            missing && needed !== undefined
              ? [{ draftId: id(needed), draftVersion: versions.get(needed) ?? 1 }]
              : [],
          ...(conflict ? { conflict: { draftId: item.draftId, columns: ['content'] } } : {}),
        },
      ];
    });
    const ok = items.every((i) => i.errors.length === 0);
    return { ok, items, errors: [], dryRun: ok ? 'ran' : 'skipped' };
  };

  return {
    pending: (): Promise<PendingSummary> => {
      const items = SAMPLES.filter((s) => open.has(s.n)).map((s) =>
        itemOf(s, role, versions.get(s.n) ?? 1),
      );
      return settle({ items, total: items.length, truncated: false });
    },
    validate: (selection) => settle(check(selection)),
    publish: (selection): Promise<PublishResult> => {
      const result = check(selection);
      if (!result.ok) {
        return Promise.reject(new Error('The sample check found something to fix.'));
      }
      number += 1;
      const published = selection.items.flatMap((ref) => byDraft(ref.draftId) ?? []);
      open = new Set([...open].filter((n) => !published.some((s) => s.n === n)));
      return settle({
        release: { id: id(999), number },
        items: published.map((s) => ({
          entityType: s.entityType,
          entityId: id(100 + s.n),
          op: s.op,
        })),
        warnings: [],
        purge: 'skipped',
      });
    },
    discard: (request) => {
      const gone =
        'scope' in request
          ? SAMPLES.filter((s) => s.mine && open.has(s.n))
          : request.items.flatMap((ref) => byDraft(ref.draftId) ?? []);
      open = new Set([...open].filter((n) => !gone.some((s) => s.n === n)));
      return settle({ discarded: gone.length, more: false });
    },
    resolve: (draftId) => {
      const sample = byDraft(draftId);
      if (sample?.n === CONFLICTED) {
        conflicted = false;
        versions.set(sample.n, (versions.get(sample.n) ?? 1) + 1);
      }
      return settle({ resolved: draftId });
    },
    compare: (draftId): Promise<CompareResult> =>
      settle({
        draftId,
        draftVersion: versions.get(byDraft(draftId)?.n ?? 0) ?? 1,
        removed: false,
        columns: [
          {
            column: 'content',
            label: 'Headline',
            kind: 'bilingual',
            live: { en: 'Made to be remembered', ar: 'صُنع ليُذكر' },
            yours: { en: 'Made to last', ar: 'صُنع ليبقى' },
          },
        ],
      }),
  };
}
