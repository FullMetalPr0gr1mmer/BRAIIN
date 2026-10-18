import { UUID, VALID_BILINGUAL, type Case } from '../harness';

// Releases (Admin v2 track REL). R3a: flag-on twins of kernel rows. With releases on a save
// becomes a pending change (src/lib/release/staged.ts), and each twin's allow set is its
// flag-off row's, word for word: staging moves no gate. The stub answers
// `rpc('releases_enabled')` with true for these rows only.

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
];
