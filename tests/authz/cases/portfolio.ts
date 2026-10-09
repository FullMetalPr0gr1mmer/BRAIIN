import { UUID, VALID_BILINGUAL, type Case } from '../harness';

// Projects: case studies (one save_portfolio transaction, UI v2 PR4b) and the sectors
// they are tagged with (§5 "Portfolio", "Categories management").

export const cases: readonly Case[] = [
  {
    name: 'portfolio list',
    load: () => import('@/pages/api/admin/portfolio/index'),
    method: 'GET',
    url: '/api/admin/portfolio',
    // SEO reviews a case study's meta through `seo.entityMeta`.
    allow: ['admin', 'content_creator', 'seo'],
  },
  {
    name: 'portfolio create (save_portfolio)',
    load: () => import('@/pages/api/admin/portfolio/index'),
    method: 'POST',
    url: '/api/admin/portfolio',
    body: { slug: 'the-rider', title: VALID_BILINGUAL, status: 'draft' },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'portfolio read one',
    load: () => import('@/pages/api/admin/portfolio/[id]'),
    method: 'GET',
    url: `/api/admin/portfolio/${UUID}`,
    allow: ['admin', 'content_creator', 'seo'],
  },
  {
    name: 'portfolio publish',
    load: () => import('@/pages/api/admin/portfolio/[id]'),
    method: 'PATCH',
    url: `/api/admin/portfolio/${UUID}`,
    body: { status: 'published', version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'portfolio services-only update (child set)',
    load: () => import('@/pages/api/admin/portfolio/[id]'),
    method: 'PATCH',
    url: `/api/admin/portfolio/${UUID}`,
    body: { serviceIds: [UUID], version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'portfolio delete',
    load: () => import('@/pages/api/admin/portfolio/[id]'),
    method: 'DELETE',
    url: `/api/admin/portfolio/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'portfolio reorder',
    load: () => import('@/pages/api/admin/portfolio/reorder'),
    method: 'POST',
    url: '/api/admin/portfolio/reorder',
    body: { items: [{ id: UUID, sortOrder: 10 }] },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'sectors list',
    load: () => import('@/pages/api/admin/sectors/index'),
    method: 'GET',
    url: '/api/admin/sectors',
    // SEO: the case-study editor's Industry picker.
    allow: ['admin', 'content_creator', 'seo'],
  },
  {
    name: 'sectors create',
    load: () => import('@/pages/api/admin/sectors/index'),
    method: 'POST',
    url: '/api/admin/sectors',
    body: { slug: 'automotive', name: VALID_BILINGUAL },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'sectors read one',
    load: () => import('@/pages/api/admin/sectors/[id]'),
    method: 'GET',
    url: `/api/admin/sectors/${UUID}`,
    allow: ['admin', 'content_creator', 'seo'],
  },
  {
    name: 'sectors update',
    load: () => import('@/pages/api/admin/sectors/[id]'),
    method: 'PATCH',
    url: `/api/admin/sectors/${UUID}`,
    body: { name: VALID_BILINGUAL, version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'sectors delete',
    load: () => import('@/pages/api/admin/sectors/[id]'),
    method: 'DELETE',
    url: `/api/admin/sectors/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'sectors reorder',
    load: () => import('@/pages/api/admin/sectors/reorder'),
    method: 'POST',
    url: '/api/admin/sectors/reorder',
    body: { items: [{ id: UUID, sortOrder: 10 }] },
    allow: ['admin', 'content_creator'],
  },
];
