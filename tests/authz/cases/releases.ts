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
];
