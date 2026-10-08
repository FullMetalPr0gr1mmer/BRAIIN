import { UUID, VALID_BILINGUAL, type Case } from '../harness';

// Pages and their sections (§5 "Pages & sections — edit/reorder/style"), and the page
// visibility switch (§5 "Maintenance / hidden pages / page visibility").

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
    body: { slug: 'about', title: VALID_BILINGUAL, status: 'draft' },
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
    name: 'page visibility toggle',
    load: () => import('@/pages/api/admin/pages/visibility/[id]'),
    method: 'PATCH',
    url: `/api/admin/pages/visibility/${UUID}`,
    body: { navVisible: false, version: 1 },
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
];
