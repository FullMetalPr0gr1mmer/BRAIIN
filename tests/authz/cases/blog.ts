import { UUID, VALID_BILINGUAL, type Case } from '../harness';

// Creative Knowledge: blog posts and their categories (§5 "Blog", "Categories management").

export const cases: readonly Case[] = [
  {
    name: 'blog list',
    load: () => import('@/pages/api/admin/blog/index'),
    method: 'GET',
    url: '/api/admin/blog',
    // SEO reaches posts through `seo.entityMeta`, to write their meta.
    allow: ['admin', 'content_creator', 'seo'],
  },
  {
    name: 'blog create',
    load: () => import('@/pages/api/admin/blog/index'),
    method: 'POST',
    url: '/api/admin/blog',
    body: { slug: 'a-post', title: VALID_BILINGUAL, status: 'draft' },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'blog read one',
    load: () => import('@/pages/api/admin/blog/[id]'),
    method: 'GET',
    url: `/api/admin/blog/${UUID}`,
    allow: ['admin', 'content_creator', 'seo'],
  },
  {
    name: 'blog update',
    load: () => import('@/pages/api/admin/blog/[id]'),
    method: 'PATCH',
    url: `/api/admin/blog/${UUID}`,
    body: { title: VALID_BILINGUAL, version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'blog delete',
    load: () => import('@/pages/api/admin/blog/[id]'),
    method: 'DELETE',
    url: `/api/admin/blog/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'categories list',
    load: () => import('@/pages/api/admin/categories/index'),
    method: 'GET',
    url: '/api/admin/categories',
    // Read by the post editor's picker too: blog.write, and SEO's entity meta.
    allow: ['admin', 'content_creator', 'seo'],
  },
  {
    name: 'categories create',
    load: () => import('@/pages/api/admin/categories/index'),
    method: 'POST',
    url: '/api/admin/categories',
    body: { slug: 'brand-strategy', name: VALID_BILINGUAL },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'categories read one',
    load: () => import('@/pages/api/admin/categories/[id]'),
    method: 'GET',
    url: `/api/admin/categories/${UUID}`,
    allow: ['admin', 'content_creator', 'seo'],
  },
  {
    name: 'categories update',
    load: () => import('@/pages/api/admin/categories/[id]'),
    method: 'PATCH',
    url: `/api/admin/categories/${UUID}`,
    body: { name: VALID_BILINGUAL, version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'categories delete',
    load: () => import('@/pages/api/admin/categories/[id]'),
    method: 'DELETE',
    url: `/api/admin/categories/${UUID}`,
    allow: ['admin'],
  },
];
