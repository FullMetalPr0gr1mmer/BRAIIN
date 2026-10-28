import { TENANT, UUID, VALID_BILINGUAL, type Case } from '../harness';

// Releases (Admin v2 track REL). R3a: flag-on twins of kernel rows. With releases on a save
// becomes a pending change (src/lib/release/staged.ts), and each twin's allow set is its
// flag-off row's, word for word: staging moves no gate. The stub answers
// `rpc('releases_enabled')` with true for these rows only.
//
// R3b: the same twins for the staged singletons and entity SEO; the intake switch (Admin only,
// releases on or off); and the draft endpoints. Those admit any role that stages (or, for the
// summary, reads) something, then check each draft against its own type: the per-item rows
// below hand the stub a draft of one type (every table answers it) and expect only that type's
// author roles through.

/** A stored draft of one type, as content_drafts returns it (and, here, as live answers). */
const draftRow = (
  entityType: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  id: UUID,
  tenant_id: TENANT,
  entity_type: entityType,
  entity_id: entityType === 'site_profile' ? TENANT : UUID,
  op: 'update',
  payload,
  base: {},
  base_version: 1,
  fields: [],
  label: null,
  version: 1,
  created_at: '2026-10-18T08:00:00Z',
  updated_at: '2026-10-18T08:00:00Z',
  updated_by: UUID,
  release_id: null,
  ...extra,
});

const SERVICE_DRAFT = draftRow('service', { title: VALID_BILINGUAL }, { title: VALID_BILINGUAL });
const PROFILE_DRAFT = draftRow(
  'site_profile',
  { brandName: VALID_BILINGUAL },
  { brand_name: VALID_BILINGUAL, accepting_applications: false },
);
const SEO_DRAFT = draftRow(
  'entity_seo',
  {
    entityType: 'service',
    entityId: UUID,
    metaTitle: VALID_BILINGUAL,
    metaDescription: VALID_BILINGUAL,
  },
  { meta_title: VALID_BILINGUAL, meta_description: VALID_BILINGUAL },
);

/** DELETE and resolve over one draft of each kind: only its type's author roles pass. */
const perItem: readonly Case[] = (
  [
    ['a service', SERVICE_DRAFT, ['admin', 'content_creator'], 'title'],
    ['the public identity', PROFILE_DRAFT, ['admin', 'developer'], 'brand_name'],
    ['entity SEO', SEO_DRAFT, ['admin', 'seo'], 'meta_title'],
  ] as const
).flatMap(([what, row, allow, column]): Case[] => [
  {
    name: `draft discard: ${what}`,
    load: () => import('@/pages/api/admin/drafts/[id]'),
    method: 'DELETE',
    url: `/api/admin/drafts/${UUID}?version=1`,
    allow: [...allow],
    row,
  },
  {
    name: `draft resolve: ${what}`,
    load: () => import('@/pages/api/admin/drafts/[id]/resolve'),
    method: 'POST',
    url: `/api/admin/drafts/${UUID}/resolve`,
    body: { version: 1, keepMine: [column] },
    allow: [...allow],
    row,
    releases: true,
  },
  {
    name: `draft discard selected: ${what}`,
    load: () => import('@/pages/api/admin/drafts/discard'),
    method: 'POST',
    url: '/api/admin/drafts/discard',
    body: { items: [{ draftId: UUID, draftVersion: 1 }] },
    allow: [...allow],
    row,
  },
]);

// R12: Compare, a read of one change against live. Admitted for every role that reads some
// release-managed type, then the change's own type decides: who reads it in the admin.
const compareItems: readonly Case[] = (
  [
    ['a service', SERVICE_DRAFT, ['admin', 'content_creator', 'seo']],
    ['the public identity', PROFILE_DRAFT, ['admin', 'developer']],
    ['entity SEO', SEO_DRAFT, ['admin', 'content_creator', 'seo']],
  ] as const
).map(([what, row, allow]): Case => ({
  name: `draft compare: ${what}`,
  load: () => import('@/pages/api/admin/drafts/[id]/compare'),
  method: 'GET',
  url: `/api/admin/drafts/${UUID}/compare`,
  allow: [...allow],
  row,
}));

// R6: publishing and its check. The kernel admits every role that publishes some area; each
// selected change is then checked against what ITS publish needs (the release publish matrix,
// architecture §3.4). One draft per row (the stub answers it from every table), both routes,
// releases on; and releases off, where both answer 409 to every role the kernel admits.
const THEME_DRAFT = draftRow('custom_theme', { name: 'Night' }, { name: 'Night' });
const DEFAULTS_DRAFT = draftRow(
  'seo_defaults',
  { robotsDirectives: 'index,follow' },
  { entity_id: TENANT, robots_directives: 'index,follow' },
);
const REDIRECT_DRAFT = draftRow(
  'redirect',
  { sourcePath: '/old', targetPath: '/services' },
  { source_path: '/old', target_path: '/services' },
);
const VISIBILITY_DRAFT = draftRow('page_visibility', { mode: 'hidden' }, { mode: 'hidden' });

const publishItems: readonly Case[] = (
  [
    ['a service change', SERVICE_DRAFT, ['admin', 'content_creator']],
    ['a service archive', { ...SERVICE_DRAFT, payload: { status: 'archived' } }, ['admin']],
    ['a service removal', { ...SERVICE_DRAFT, op: 'delete', payload: {} }, ['admin']],
    ['the public identity', PROFILE_DRAFT, ['admin', 'developer']],
    ['a theme', THEME_DRAFT, ['admin', 'developer']],
    ['entity SEO', SEO_DRAFT, ['admin', 'seo']],
    ['the SEO defaults', DEFAULTS_DRAFT, ['admin', 'seo']],
    ['a redirect', REDIRECT_DRAFT, ['admin', 'seo']],
    ['a redirect removal', { ...REDIRECT_DRAFT, op: 'delete', payload: {} }, ['admin', 'seo']],
    ['page visibility', VISIBILITY_DRAFT, ['admin', 'developer']],
  ] as const
).flatMap(([what, row, allow]): Case[] =>
  (
    [
      ['publish', () => import('@/pages/api/admin/releases/index'), '/api/admin/releases'],
      [
        'validate',
        () => import('@/pages/api/admin/releases/validate'),
        '/api/admin/releases/validate',
      ],
    ] as const
  ).map(([verb, load, url]) => ({
    name: `release ${verb}: ${what}`,
    load,
    method: 'POST',
    url,
    body: { items: [{ draftId: UUID, draftVersion: 1 }] },
    allow: [...allow],
    row,
    releases: true,
  })),
);

const publishOff: readonly Case[] = (
  [
    ['publish', () => import('@/pages/api/admin/releases/index'), '/api/admin/releases'],
    [
      'validate',
      () => import('@/pages/api/admin/releases/validate'),
      '/api/admin/releases/validate',
    ],
  ] as const
).map(([verb, load, url]) => ({
  name: `release ${verb} (releases off)`,
  load,
  method: 'POST',
  url,
  body: { items: [{ draftId: UUID, draftVersion: 1 }] },
  allow: ['admin', 'content_creator', 'seo', 'developer'],
  row: SERVICE_DRAFT,
}));

// R10: versions, history and restore. The reads admit every CMS role that reads a
// release-managed area (each change is then listed only in an area the person reads); an
// entity's history needs that entity's area. A restore admits every publisher, then refuses,
// per change it would stage, what the person cannot publish (P-2): one version holding one
// theme change (Admin, Developer) and one holding one service change (Admin, Content Creator),
// so a Content Creator restoring the theme's version is refused (the cross-area row). The stub's
// one row is the version, the live row and the history snapshot at once.
const VERSION_ROW = {
  id: UUID,
  tenant_id: TENANT,
  number: 1,
  status: 'published',
  kind: 'publish',
  version: 2,
  seq: 1,
  name: 'Night',
  title: VALID_BILINGUAL,
  snapshot: { title: { en: 'Before', ar: 'قبل' } },
};
const asOf = (entityType: string, before: Record<string, unknown>) => ({
  release: {
    id: UUID,
    number: 1,
    kind: 'publish',
    note: null,
    published_at: '2026-10-18T08:00:00Z',
    published_by: UUID,
  },
  cutoff: 3,
  total: 1,
  entities: [{ entity_type: entityType, entity_id: UUID, before, exists_now: true, page_id: null }],
});
const staged = (entityType: string) => [
  { action: 'put', draft_id: UUID, entity_type: entityType, entity_id: UUID, version: 1 },
];

const versions: readonly Case[] = [
  {
    name: 'versions list',
    load: () => import('@/pages/api/admin/releases/index'),
    method: 'GET',
    url: '/api/admin/releases',
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  {
    name: 'version detail',
    load: () => import('@/pages/api/admin/releases/[id]'),
    method: 'GET',
    url: `/api/admin/releases/${UUID}`,
    allow: ['admin', 'content_creator', 'seo', 'developer'],
    row: VERSION_ROW,
  },
  {
    name: 'version restore: a theme change',
    load: () => import('@/pages/api/admin/releases/[id]/restore'),
    method: 'POST',
    url: `/api/admin/releases/${UUID}/restore`,
    body: {},
    allow: ['admin', 'developer'],
    releases: true,
    row: VERSION_ROW,
    rpcs: {
      release_as_of: asOf('custom_theme', { name: 'Day' }),
      write_drafts: staged('custom_theme'),
    },
  },
  {
    name: 'version restore: a service change',
    load: () => import('@/pages/api/admin/releases/[id]/restore'),
    method: 'POST',
    url: `/api/admin/releases/${UUID}/restore`,
    body: {},
    allow: ['admin', 'content_creator'],
    releases: true,
    row: VERSION_ROW,
    rpcs: {
      release_as_of: asOf('service', { title: { en: 'Before', ar: 'قبل' } }),
      write_drafts: staged('service'),
    },
  },
  {
    name: 'version restore: one page',
    load: () => import('@/pages/api/admin/releases/[id]/restore'),
    method: 'POST',
    url: `/api/admin/releases/${UUID}/restore`,
    body: { pageId: UUID },
    allow: ['admin', 'content_creator'],
    releases: true,
    row: VERSION_ROW,
    rpcs: {
      release_as_of: asOf('page', { title: { en: 'Before', ar: 'قبل' } }),
      write_drafts: staged('page'),
    },
  },
  {
    name: 'version restore (releases off)',
    load: () => import('@/pages/api/admin/releases/[id]/restore'),
    method: 'POST',
    url: `/api/admin/releases/${UUID}/restore`,
    body: {},
    allow: ['admin', 'content_creator', 'seo', 'developer'],
    row: VERSION_ROW,
  },
  {
    name: 'history: a service',
    load: () => import('@/pages/api/admin/history/index'),
    method: 'GET',
    url: `/api/admin/history?entityType=service&entityId=${UUID}`,
    allow: ['admin', 'content_creator', 'seo'],
    row: VERSION_ROW,
  },
  {
    name: 'history: a page and its sections',
    load: () => import('@/pages/api/admin/history/index'),
    method: 'GET',
    url: `/api/admin/history?entityType=page&entityId=${UUID}&scope=page`,
    allow: ['admin', 'content_creator', 'seo', 'developer'],
    row: VERSION_ROW,
  },
  {
    name: 'history restore: a service',
    load: () => import('@/pages/api/admin/history/restore'),
    method: 'POST',
    url: '/api/admin/history/restore',
    body: { entityType: 'service', entityId: UUID, seq: 1 },
    allow: ['admin', 'content_creator'],
    releases: true,
    row: VERSION_ROW,
    rpcs: { write_drafts: staged('service') },
  },
  {
    name: 'history restore (releases off)',
    load: () => import('@/pages/api/admin/history/restore'),
    method: 'POST',
    url: '/api/admin/history/restore',
    body: { entityType: 'service', entityId: UUID, seq: 1 },
    allow: ['admin', 'content_creator', 'seo'],
    row: VERSION_ROW,
  },
  {
    // A rollback publishes a restore's changes of one version, as the restore left them (its
    // write and its mark: version 2): the per-change gate is the publish's own (R6).
    name: 'release publish: a rollback of a service change',
    load: () => import('@/pages/api/admin/releases/index'),
    method: 'POST',
    url: '/api/admin/releases',
    body: { items: [{ draftId: UUID, draftVersion: 2 }], kind: 'rollback' },
    allow: ['admin', 'content_creator'],
    releases: true,
    row: {
      ...SERVICE_DRAFT,
      version: 2,
      origin_kind: 'restore',
      origin_release_id: UUID,
      number: 1,
      status: 'published',
    },
  },
];

// R11: scheduling, moving and cancelling. A schedule is a publish with a time: the same per-change
// gate. A move or a cancel admits every publisher, then each change the release holds must be the
// person's to publish (its claimed drafts; the stub's one row is the release, scheduled at version
// 1, and the claimed service change at once). Releases off: every CMS role through the gate, 409.
const AN_HOUR_AHEAD = new Date(Date.now() + 60 * 60_000).toISOString();
const SCHEDULED_ROW = { ...SERVICE_DRAFT, status: 'scheduled', release_id: UUID, version: 1 };

const scheduling: readonly Case[] = [
  {
    name: 'release schedule: a service change',
    load: () => import('@/pages/api/admin/releases/index'),
    method: 'POST',
    url: '/api/admin/releases',
    body: { items: [{ draftId: UUID, draftVersion: 1 }], scheduleAt: AN_HOUR_AHEAD },
    allow: ['admin', 'content_creator'],
    row: SERVICE_DRAFT,
    releases: true,
    rpcs: {
      apply_release: {
        mode: 'schedule',
        release_id: UUID,
        scheduled_for: AN_HOUR_AHEAD,
        version: 1,
        item_count: 1,
      },
    },
  },
  {
    name: 'release reschedule: a release of a service change',
    load: () => import('@/pages/api/admin/releases/[id]'),
    method: 'PATCH',
    url: `/api/admin/releases/${UUID}`,
    body: { version: 1, scheduleAt: AN_HOUR_AHEAD },
    allow: ['admin', 'content_creator'],
    row: SCHEDULED_ROW,
    releases: true,
    rpcs: { reschedule_release: { release_id: UUID, scheduled_for: AN_HOUR_AHEAD, version: 2 } },
  },
  {
    name: 'release unschedule: a release of a service change',
    load: () => import('@/pages/api/admin/releases/[id]'),
    method: 'DELETE',
    url: `/api/admin/releases/${UUID}?version=1`,
    allow: ['admin', 'content_creator'],
    row: SCHEDULED_ROW,
    releases: true,
    rpcs: { unschedule_release: { release_id: UUID, status: 'cancelled', released: 1 } },
  },
  {
    name: 'release reschedule (releases off)',
    load: () => import('@/pages/api/admin/releases/[id]'),
    method: 'PATCH',
    url: `/api/admin/releases/${UUID}`,
    body: { version: 1, scheduleAt: AN_HOUR_AHEAD },
    allow: ['admin', 'content_creator', 'seo', 'developer'],
    row: SCHEDULED_ROW,
  },
  {
    name: 'release unschedule (releases off)',
    load: () => import('@/pages/api/admin/releases/[id]'),
    method: 'DELETE',
    url: `/api/admin/releases/${UUID}?version=1`,
    allow: ['admin', 'content_creator', 'seo', 'developer'],
    row: SCHEDULED_ROW,
  },
];

export const cases: readonly Case[] = [
  {
    name: 'services create (releases on)',
    load: () => import('@/pages/api/admin/services/index'),
    method: 'POST',
    url: '/api/admin/services',
    body: { slug: 'logo', title: VALID_BILINGUAL, status: 'draft' },
    allow: ['admin', 'content_creator'],
    releases: true,
  },
  {
    name: 'services publish (releases on)',
    load: () => import('@/pages/api/admin/services/[id]'),
    method: 'PATCH',
    url: `/api/admin/services/${UUID}`,
    body: { status: 'published', title: VALID_BILINGUAL, version: 1 },
    allow: ['admin', 'content_creator'],
    releases: true,
  },
  {
    name: 'services archive (releases on, Admin-only transition)',
    load: () => import('@/pages/api/admin/services/[id]'),
    method: 'PATCH',
    url: `/api/admin/services/${UUID}`,
    body: { status: 'archived', version: 1 },
    allow: ['admin'],
    releases: true,
  },
  {
    name: 'services delete (releases on)',
    load: () => import('@/pages/api/admin/services/[id]'),
    method: 'DELETE',
    url: `/api/admin/services/${UUID}`,
    allow: ['admin'],
    releases: true,
  },
  {
    name: 'services reorder (releases on)',
    load: () => import('@/pages/api/admin/services/reorder'),
    method: 'POST',
    url: '/api/admin/services/reorder',
    body: { items: [{ id: UUID, sortOrder: 10 }] },
    allow: ['admin', 'content_creator'],
    releases: true,
  },
  {
    // Hotfix H12: a row that stays archived is an Admin's to move, staged as live; the apply
    // runs as the publisher, whom the archive gates would refuse.
    name: 'services reorder naming an archived row (releases on, Admin only)',
    load: () => import('@/pages/api/admin/services/reorder'),
    method: 'POST',
    url: '/api/admin/services/reorder',
    body: { items: [{ id: UUID, sortOrder: 10 }] },
    row: { id: UUID, version: 1, status: 'archived' },
    allow: ['admin'],
    releases: true,
  },
  {
    // Hotfix H12, the same rule for any edit: a change that leaves an archived row archived
    // (a title here) is an Admin's to stage, as it is to publish (tests/lib/stagedKernel.spec.ts).
    // Every table answers the one row, so it is the pending edit the save names and, with its
    // `status`, the archived live row.
    name: 'services edit of an archived row (releases on, Admin only)',
    load: () => import('@/pages/api/admin/services/[id]'),
    method: 'PATCH',
    url: `/api/admin/services/${UUID}`,
    body: { title: VALID_BILINGUAL, version: 1, draftId: UUID, draftVersion: 1 },
    row: draftRow('service', { title: VALID_BILINGUAL }, { status: 'archived' }),
    allow: ['admin'],
    releases: true,
  },
  {
    name: 'testimonials publish (releases on)',
    load: () => import('@/pages/api/admin/testimonials/[id]'),
    method: 'PATCH',
    url: `/api/admin/testimonials/${UUID}`,
    body: { status: 'published', version: 1 },
    allow: ['admin', 'content_creator'],
    releases: true,
  },
  {
    name: 'clients clear for disclosure (releases on, visible = publish)',
    load: () => import('@/pages/api/admin/clients/[id]'),
    method: 'PATCH',
    url: `/api/admin/clients/${UUID}`,
    body: { visible: true, version: 1 },
    allow: ['admin', 'content_creator'],
    releases: true,
  },
  {
    name: 'categories delete (releases on)',
    load: () => import('@/pages/api/admin/categories/[id]'),
    method: 'DELETE',
    url: `/api/admin/categories/${UUID}`,
    allow: ['admin'],
    releases: true,
  },
  // ── R3b ─────────────────────────────────────────────────────────────────────────────────
  {
    name: 'site profile write (releases on)',
    load: () => import('@/pages/api/admin/site-profile'),
    method: 'PATCH',
    url: '/api/admin/site-profile',
    body: { brandName: VALID_BILINGUAL, version: 1 },
    allow: ['admin', 'developer'],
    releases: true,
  },
  {
    // Staged or not, opening the intake is Admin only in the Worker (guardWrite), before the
    // staged save refuses the changed switch with 422 and points to the intake endpoint.
    name: 'site profile opens job applications (releases on, Admin-only)',
    load: () => import('@/pages/api/admin/site-profile'),
    method: 'PATCH',
    url: '/api/admin/site-profile',
    body: { acceptingApplications: true, draftId: UUID, draftVersion: 1 },
    allow: ['admin'],
    releases: true,
    row: PROFILE_DRAFT,
  },
  {
    name: 'global SEO defaults write (releases on)',
    load: () => import('@/pages/api/admin/seo-defaults'),
    method: 'PATCH',
    url: '/api/admin/seo-defaults',
    body: { robotsDirectives: 'index,follow', version: 1 },
    allow: ['admin', 'seo'],
    releases: true,
  },
  {
    name: 'entity SEO write (releases on)',
    load: () => import('@/pages/api/admin/entity-seo'),
    method: 'PUT',
    url: '/api/admin/entity-seo',
    body: {
      entityType: 'service',
      entityId: UUID,
      metaTitle: VALID_BILINGUAL,
      metaDescription: VALID_BILINGUAL,
      version: 1,
    },
    allow: ['admin', 'seo'],
    releases: true,
  },
  {
    name: 'entity SEO read (releases on)',
    load: () => import('@/pages/api/admin/entity-seo'),
    method: 'GET',
    url: `/api/admin/entity-seo?entityType=service&entityId=${UUID}`,
    allow: ['admin', 'seo', 'content_creator'],
    releases: true,
  },
  {
    // The job-application switch: immediate whatever the flag, Admin only (applications.manage
    // and settings.general in the Worker; the 0019 trigger in the database).
    name: 'site profile intake (Admin only)',
    load: () => import('@/pages/api/admin/site-profile/intake'),
    method: 'PATCH',
    url: '/api/admin/site-profile/intake',
    body: { acceptingApplications: true },
    allow: ['admin'],
  },
  {
    name: 'site profile intake (releases on, Admin only)',
    load: () => import('@/pages/api/admin/site-profile/intake'),
    method: 'PATCH',
    url: '/api/admin/site-profile/intake',
    body: { acceptingApplications: false },
    allow: ['admin'],
    releases: true,
  },
  {
    name: 'pending changes summary',
    load: () => import('@/pages/api/admin/releases/pending'),
    method: 'GET',
    url: '/api/admin/releases/pending',
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  {
    name: 'draft discard mine',
    load: () => import('@/pages/api/admin/drafts/discard'),
    method: 'POST',
    url: '/api/admin/drafts/discard',
    body: { scope: 'mine' },
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  ...perItem,
  ...compareItems,
  ...publishItems,
  ...publishOff,
  ...versions,
  ...scheduling,
];
