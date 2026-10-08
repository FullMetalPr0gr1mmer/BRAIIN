import { UUID, VALID_BILINGUAL, type Case } from '../harness';

// SEO: per-entity meta, the global defaults and the redirects module (§5 "Per-entity SEO
// meta", "Global SEO defaults", "Redirects / canonical module").

export const cases: readonly Case[] = [
  {
    name: 'entity SEO read',
    load: () => import('@/pages/api/admin/entity-seo'),
    method: 'GET',
    url: `/api/admin/entity-seo?entityType=service&entityId=${UUID}`,
    // Content Creator holds 'view' on seo.entityMeta.
    allow: ['admin', 'seo', 'content_creator'],
  },
  {
    name: 'entity SEO write',
    load: () => import('@/pages/api/admin/entity-seo'),
    method: 'PUT',
    url: '/api/admin/entity-seo',
    body: {
      entityType: 'service',
      entityId: UUID,
      metaTitle: VALID_BILINGUAL,
      metaDescription: VALID_BILINGUAL,
      version: 0,
    },
    allow: ['admin', 'seo'],
  },
  {
    name: 'global SEO defaults read',
    load: () => import('@/pages/api/admin/seo-defaults'),
    method: 'GET',
    url: '/api/admin/seo-defaults',
    allow: ['admin', 'seo'],
  },
  {
    name: 'global SEO defaults write',
    load: () => import('@/pages/api/admin/seo-defaults'),
    method: 'PATCH',
    url: '/api/admin/seo-defaults',
    body: { robotsDirectives: 'index,follow', version: 1 },
    allow: ['admin', 'seo'],
  },
  // Redirects: §5 grants Admin + SEO the whole module — reads, writes AND deletes (the
  // resource names `deleteCap: 'redirects.manage'`, Round 3) and the edge sync.
  {
    name: 'redirects list',
    load: () => import('@/pages/api/admin/redirects/index'),
    method: 'GET',
    url: '/api/admin/redirects',
    allow: ['admin', 'seo'],
  },
  {
    name: 'redirects create',
    load: () => import('@/pages/api/admin/redirects/index'),
    method: 'POST',
    url: '/api/admin/redirects',
    body: { sourcePath: '/old', targetPath: '/new', status: 301 },
    allow: ['admin', 'seo'],
  },
  {
    name: 'redirects read one',
    load: () => import('@/pages/api/admin/redirects/[id]'),
    method: 'GET',
    url: `/api/admin/redirects/${UUID}`,
    allow: ['admin', 'seo'],
  },
  {
    name: 'redirects update',
    load: () => import('@/pages/api/admin/redirects/[id]'),
    method: 'PATCH',
    url: `/api/admin/redirects/${UUID}`,
    body: { targetPath: '/new', version: 1 },
    allow: ['admin', 'seo'],
  },
  {
    name: 'redirects delete (SEO may — not the content default)',
    load: () => import('@/pages/api/admin/redirects/[id]'),
    method: 'DELETE',
    url: `/api/admin/redirects/${UUID}`,
    allow: ['admin', 'seo'],
  },
  {
    name: 'redirects edge status',
    load: () => import('@/pages/api/admin/redirects/sync'),
    method: 'GET',
    url: '/api/admin/redirects/sync',
    allow: ['admin', 'seo'],
  },
  {
    name: 'redirects sync to edge',
    load: () => import('@/pages/api/admin/redirects/sync'),
    method: 'POST',
    url: '/api/admin/redirects/sync',
    allow: ['admin', 'seo'],
  },
];
