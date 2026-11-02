import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { CUSTOM_PAGE_ADDRESS_FIXED } from '@schemas/customPages';
import { ValidationError } from '@/lib/admin/errors';

// A page's own writes after custom pages (Admin v2 E11 code review):
//   CR3  a custom page's address never changes, and no page takes one by rename: the New page
//        dialog promises it, a rename would leave the old `/<slug>` cached at the edge (a save
//        purges the new `page:<slug>` only), and a page renamed INTO a custom address would
//        bring sections the custom set refuses. The rule is the resource's, so the live PATCH
//        and a staged save or a release's validation (which run the same assertWritable) hold it;
//   CR1  a custom page that stops or starts rendering (its status moved, or it was deleted) has
//        the edge's visibility snapshot follow, so a hidden page that sends its visitors there
//        never answers a 302 to a 404.

const resyncs = vi.hoisted(() => [] as { id: string; slug: string }[]);
vi.mock('@/lib/admin/visibilitySync', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resyncRedirectTarget: async (
    _sb: unknown,
    _auth: unknown,
    page: { id: string; slug: string },
  ) => {
    resyncs.push(page);
    return { kvSynced: true, count: 1 };
  },
}));

const { pageResource } = await import('@/lib/admin/resources/pages');

const AUTH = { tenantId: 't-1', role: 'content_creator' } as unknown as AuthContext;
const SB = {} as SupabaseClient;
const ID = '00000000-0000-4000-8000-00000000e110';

beforeEach(() => {
  resyncs.length = 0;
});

describe('a page’s address (CR3)', () => {
  const check = (was: string, now: string | undefined) => {
    const before = { id: ID, slug: was, title: { en: 'T', ar: 'ت' }, status: 'draft' };
    const changed = now === undefined ? { title: { en: 'U', ar: 'ي' } } : { slug: now };
    return (async () =>
      pageResource.assertWritable?.(
        { ...before, ...changed },
        { auth: AUTH, sb: SB, changed, before },
      ))();
  };

  it('a custom page keeps its address', async () => {
    for (const now of ['our-new-story', 'about', 'Our-Story-2']) {
      await expect(check('our-story', now), now).rejects.toMatchObject({
        field: 'slug',
        detail: CUSTOM_PAGE_ADDRESS_FIXED,
      });
    }
  });

  it('no page takes a custom address by rename', async () => {
    // A row no route renders (a legacy word), or a route page (0057 refuses that one too).
    for (const was of ['old-admin-page_', 'about']) {
      await expect(check(was, 'our-story'), was).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('a save that restates the address, or leaves it out, passes', async () => {
    await expect(check('our-story', 'our-story')).resolves.toBeUndefined();
    await expect(check('our-story', 'OUR-STORY')).resolves.toBeUndefined();
    await expect(check('our-story', undefined)).resolves.toBeUndefined();
  });

  it('a new page (no row before it) is the dialog’s, with its own rules', async () => {
    const row = { slug: 'our-story', title: { en: 'T', ar: 'ت' } };
    await expect(
      (async () =>
        pageResource.assertWritable?.(row, { auth: AUTH, sb: SB, changed: row, before: null }))(),
    ).resolves.toBeUndefined();
  });
});

describe('the edge follows a custom page that stops or starts rendering (CR1)', () => {
  const update = (slug: string, from: string, to: string) =>
    pageResource.afterWrite?.({
      auth: AUTH,
      sb: SB,
      row: { id: ID, slug, status: to },
      input: { status: to } as never,
      operation: 'update',
      before: { id: ID, slug, status: from },
    });

  it('a custom page’s status change resyncs; a route page’s, or a save that keeps it, does not', async () => {
    expect(await update('our-story', 'published', 'draft')).toEqual({ visibilityKvSynced: true });
    expect(await update('our-story', 'draft', 'published')).toEqual({ visibilityKvSynced: true });
    expect(await update('our-story', 'published', 'published')).toEqual({});
    expect(await update('about', 'published', 'draft')).toEqual({});
    expect(resyncs).toEqual([
      { id: ID, slug: 'our-story' },
      { id: ID, slug: 'our-story' },
    ]);
  });

  it('a custom page deleted resyncs; a route page needs nothing here (its route still renders)', async () => {
    await pageResource.afterDelete?.({
      auth: AUTH,
      sb: SB,
      id: ID,
      row: { id: ID, slug: 'our-story' },
    });
    await pageResource.afterDelete?.({
      auth: AUTH,
      sb: SB,
      id: ID,
      row: { id: ID, slug: 'about' },
    });
    expect(resyncs).toEqual([{ id: ID, slug: 'our-story' }]);
  });
});
