import { UUID, VALID_BILINGUAL, type Case } from '../harness';

// AI Style-Finder authoring (§5): questions and styles are `ai.editContent` (Admin +
// Content Creator); the results and logic config is `ai.config` (Admin only).

export const cases: readonly Case[] = [
  {
    name: 'style-finder questions list',
    load: () => import('@/pages/api/admin/ai-questions/index'),
    method: 'GET',
    url: '/api/admin/ai-questions',
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'style-finder question create',
    load: () => import('@/pages/api/admin/ai-questions/index'),
    method: 'POST',
    url: '/api/admin/ai-questions',
    body: { slug: 'vibe', prompt: VALID_BILINGUAL },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'style-finder question read one',
    load: () => import('@/pages/api/admin/ai-questions/[id]'),
    method: 'GET',
    url: `/api/admin/ai-questions/${UUID}`,
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'style-finder question update',
    load: () => import('@/pages/api/admin/ai-questions/[id]'),
    method: 'PATCH',
    url: `/api/admin/ai-questions/${UUID}`,
    body: { prompt: VALID_BILINGUAL, version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'style-finder question delete',
    load: () => import('@/pages/api/admin/ai-questions/[id]'),
    method: 'DELETE',
    url: `/api/admin/ai-questions/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'style-finder questions reorder',
    load: () => import('@/pages/api/admin/ai-questions/reorder'),
    method: 'POST',
    url: '/api/admin/ai-questions/reorder',
    body: { items: [{ id: UUID, sortOrder: 10 }] },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'style-finder styles list',
    load: () => import('@/pages/api/admin/ai-styles/index'),
    method: 'GET',
    url: '/api/admin/ai-styles',
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'style-finder style create',
    load: () => import('@/pages/api/admin/ai-styles/index'),
    method: 'POST',
    url: '/api/admin/ai-styles',
    body: { slug: 'minimal', name: VALID_BILINGUAL },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'style-finder style read one',
    load: () => import('@/pages/api/admin/ai-styles/[id]'),
    method: 'GET',
    url: `/api/admin/ai-styles/${UUID}`,
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'style-finder style update',
    load: () => import('@/pages/api/admin/ai-styles/[id]'),
    method: 'PATCH',
    url: `/api/admin/ai-styles/${UUID}`,
    body: { name: VALID_BILINGUAL, version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'style-finder style delete',
    load: () => import('@/pages/api/admin/ai-styles/[id]'),
    method: 'DELETE',
    url: `/api/admin/ai-styles/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'style-finder styles reorder',
    load: () => import('@/pages/api/admin/ai-styles/reorder'),
    method: 'POST',
    url: '/api/admin/ai-styles/reorder',
    body: { items: [{ id: UUID, sortOrder: 10 }] },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'style-finder logic config read',
    load: () => import('@/pages/api/admin/ai-config'),
    method: 'GET',
    url: '/api/admin/ai-config',
    // What the Results & logic screen loads on mount, and what tests/admin/refusals.e2e.ts
    // asks the real stack for as each role without the capability.
    allow: ['admin'],
  },
  {
    name: 'style-finder logic config',
    load: () => import('@/pages/api/admin/ai-config'),
    method: 'PATCH',
    url: '/api/admin/ai-config',
    body: { dailyUsdCap: 5, version: 1 },
    // Admin ALONE — Content Creator authors questions but does not tune the model.
    allow: ['admin'],
  },
];
