import { UUID, VALID_BILINGUAL, type Case } from '../harness';

// Pages and their sections (§5 "Pages & sections — edit/reorder/style"), and the legacy
// page visibility switch (§5 "Maintenance / hidden pages / page visibility"), an alias over
// page_visibility since Admin v2 U14a (the screen's own routes are in ./visibility.ts).

export const cases: readonly Case[] = [
  {
    name: 'pages list',
    load: () => import('@/pages/api/admin/pages/index'),
    method: 'GET',
    url: '/api/admin/pages',
    // SEO finds a page to write its meta (`seo.entityMeta`); Developer finds one to hide
    // (`maintenance.manage`).
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  {
    name: 'pages create',
    load: () => import('@/pages/api/admin/pages/index'),
    method: 'POST',
    url: '/api/admin/pages',
    // A custom page (Admin v2 E11). The create schema refuses a reserved word; a route slug
    // passes it, and 0001's unique key refuses one while that route's page exists.
    body: { slug: 'our-story', title: VALID_BILINGUAL, status: 'draft' },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'pages read one',
    load: () => import('@/pages/api/admin/pages/[id]'),
    method: 'GET',
    url: `/api/admin/pages/${UUID}`,
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  {
    name: 'pages update',
    load: () => import('@/pages/api/admin/pages/[id]'),
    method: 'PATCH',
    url: `/api/admin/pages/${UUID}`,
    body: { title: VALID_BILINGUAL, version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'pages delete',
    load: () => import('@/pages/api/admin/pages/[id]'),
    method: 'DELETE',
    url: `/api/admin/pages/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'page visibility toggle (alias over page_visibility)',
    load: () => import('@/pages/api/admin/pages/visibility/[id]'),
    method: 'PATCH',
    url: `/api/admin/pages/visibility/${UUID}`,
    body: { navVisible: false, version: 1 },
    // RLS agrees since 0057: page_visibility is Admin + Developer in both layers.
    allow: ['admin', 'developer'],
  },
  {
    name: 'sections list',
    load: () => import('@/pages/api/admin/sections/index'),
    method: 'GET',
    url: `/api/admin/sections?page_id=${UUID}`,
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'sections create',
    load: () => import('@/pages/api/admin/sections/index'),
    method: 'POST',
    url: '/api/admin/sections',
    body: { pageId: UUID, type: 'cta', visible: false },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'sections read one',
    load: () => import('@/pages/api/admin/sections/[id]'),
    method: 'GET',
    url: `/api/admin/sections/${UUID}`,
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'sections update',
    load: () => import('@/pages/api/admin/sections/[id]'),
    method: 'PATCH',
    url: `/api/admin/sections/${UUID}`,
    body: { sortOrder: 20, version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'sections delete',
    load: () => import('@/pages/api/admin/sections/[id]'),
    method: 'DELETE',
    url: `/api/admin/sections/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'sections reorder',
    load: () => import('@/pages/api/admin/sections/reorder'),
    method: 'POST',
    url: '/api/admin/sections/reorder',
    body: { items: [{ id: UUID, sortOrder: 10 }] },
    allow: ['admin', 'content_creator'],
  },
  // Admin v2 E3: the template pages' shared text (template_copy), §5 "Pages & sections":
  // Admin + Content Creator read and write it; SEO, Developer and Sales neither.
  {
    name: 'template shared text read',
    load: () => import('@/pages/api/admin/template-copy'),
    method: 'GET',
    url: '/api/admin/template-copy',
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'template shared text write',
    load: () => import('@/pages/api/admin/template-copy'),
    method: 'PATCH',
    url: '/api/admin/template-copy',
    body: {
      service: {
        seeCase: VALID_BILINGUAL,
        valueHeading: VALID_BILINGUAL,
        valueHeadingAccent: { en: { from: 0 }, ar: { from: 0 } },
      },
      version: 1,
    },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'template shared text write, the project page',
    load: () => import('@/pages/api/admin/template-copy'),
    method: 'PATCH',
    url: '/api/admin/template-copy',
    body: { project: { nextProject: VALID_BILINGUAL }, version: 1 },
    allow: ['admin', 'content_creator'],
  },
];
