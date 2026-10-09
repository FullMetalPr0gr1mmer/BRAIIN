import { UUID, VALID_BILINGUAL, type Case } from '../harness';

// Appearance: the theme (§5 "Theme editor", Admin + Developer) and the site menus (§5
// "Navigation editor", Admin + Content Creator).

export const cases: readonly Case[] = [
  {
    name: 'theme list',
    load: () => import('@/pages/api/admin/themes/index'),
    method: 'GET',
    url: '/api/admin/themes',
    // What the theme screen loads on mount, and what tests/admin/refusals.e2e.ts asks the
    // real stack for as each role without the capability.
    allow: ['admin', 'developer'],
  },
  {
    name: 'theme write',
    load: () => import('@/pages/api/admin/themes/index'),
    method: 'POST',
    url: '/api/admin/themes',
    body: { name: 'Neon', tokens: { '--ad-accent': '#00e5ff' } },
    allow: ['admin', 'developer'],
  },
  {
    name: 'theme read one',
    load: () => import('@/pages/api/admin/themes/[id]'),
    method: 'GET',
    url: `/api/admin/themes/${UUID}`,
    allow: ['admin', 'developer'],
  },
  {
    name: 'theme update',
    load: () => import('@/pages/api/admin/themes/[id]'),
    method: 'PATCH',
    url: `/api/admin/themes/${UUID}`,
    body: { name: 'Neon', version: 1 },
    allow: ['admin', 'developer'],
  },
  {
    // The resource kernel's default delete capability, `content.archiveDelete`, is Admin
    // only: Developer edits and activates themes but does not delete one.
    name: 'theme delete',
    load: () => import('@/pages/api/admin/themes/[id]'),
    method: 'DELETE',
    url: `/api/admin/themes/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'navigation list',
    load: () => import('@/pages/api/admin/navigation/index'),
    method: 'GET',
    url: '/api/admin/navigation?location=header',
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'navigation create',
    load: () => import('@/pages/api/admin/navigation/index'),
    method: 'POST',
    url: '/api/admin/navigation',
    body: { location: 'header', label: VALID_BILINGUAL, href: '/services' },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'navigation read one',
    load: () => import('@/pages/api/admin/navigation/[id]'),
    method: 'GET',
    url: `/api/admin/navigation/${UUID}`,
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'navigation update',
    load: () => import('@/pages/api/admin/navigation/[id]'),
    method: 'PATCH',
    url: `/api/admin/navigation/${UUID}`,
    body: { label: VALID_BILINGUAL, version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'navigation delete',
    load: () => import('@/pages/api/admin/navigation/[id]'),
    method: 'DELETE',
    url: `/api/admin/navigation/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'navigation reorder',
    load: () => import('@/pages/api/admin/navigation/reorder'),
    method: 'POST',
    url: '/api/admin/navigation/reorder',
    body: { items: [{ id: UUID, sortOrder: 10 }] },
    allow: ['admin', 'content_creator'],
  },
];
