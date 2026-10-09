import { UUID, VALID_BILINGUAL, type Case } from '../harness';

// The media library (§5 "Media — upload / edit metadata", "Media — hard delete"). SEO holds
// `media.write` at 'meta' only: it reads the library and writes metadata through its own
// path, never the full row.

export const cases: readonly Case[] = [
  {
    name: 'media list',
    load: () => import('@/pages/api/admin/media/index'),
    method: 'GET',
    url: '/api/admin/media',
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  {
    name: 'media register (external asset)',
    load: () => import('@/pages/api/admin/media/index'),
    method: 'POST',
    url: '/api/admin/media',
    body: {
      kind: 'image',
      provider: 'external',
      storagePath: 'https://images.example.test/still.jpg',
      alt: VALID_BILINGUAL,
    },
    // media.write in full: SEO's 'meta only' cannot add an asset.
    allow: ['admin', 'content_creator', 'developer'],
  },
  {
    name: 'media read one',
    load: () => import('@/pages/api/admin/media/[id]'),
    method: 'GET',
    url: `/api/admin/media/${UUID}`,
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  {
    name: 'media update (full row)',
    load: () => import('@/pages/api/admin/media/[id]'),
    method: 'PATCH',
    url: `/api/admin/media/${UUID}`,
    body: { folder: 'brand', version: 1 },
    allow: ['admin', 'content_creator', 'developer'],
  },
  {
    name: 'media hard delete (media.hardDelete — Admin only)',
    load: () => import('@/pages/api/admin/media/[id]'),
    method: 'DELETE',
    url: `/api/admin/media/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'media usage',
    load: () => import('@/pages/api/admin/media/[id]/usage'),
    method: 'GET',
    url: `/api/admin/media/${UUID}/usage`,
    // Every role that may read the library: media.write full (admin, CC, developer) or meta (SEO).
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  {
    name: 'media metadata (SEO "meta only" path)',
    load: () => import('@/pages/api/admin/media/meta/[id]'),
    method: 'PATCH',
    url: `/api/admin/media/meta/${UUID}`,
    body: { alt: VALID_BILINGUAL, version: 1 },
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
];
