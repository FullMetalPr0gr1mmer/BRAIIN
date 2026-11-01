import { describe, it, expect, vi, beforeEach } from 'vitest';

// getSectionImages: media a page section references by `mediaId` (Our Work's intro
// frames). RLS decides WHICH rows anon may read (0024); this loader decides what reaches
// the page — only well-formed ids are asked for, and only rows the public image gate
// (media/resolve.ts: static provider, a key the stills registry knows) resolves.

vi.mock('@/lib/media/static', () => ({
  staticImage: (key: string) =>
    key === 'stills/work/ia.jpg' ? { src: '/_astro/ia.jpg', width: 1280, height: 720 } : null,
}));

// E10 code review (CR3): the page scope's read and the configuration check sit inside the
// read's try, so a throw from either is an empty map, never a rejected promise (the page's
// media sections share this one read).
const fails = vi.hoisted(() => ({ scope: false, configured: false }));
vi.mock('@/lib/visibility/scope', () => ({
  pageAccess: () => {
    if (fails.scope) throw new Error('the page scope could not be read');
    return undefined;
  },
}));

let rows: unknown[] = [];
let error: unknown = null;
const asked: string[][] = [];

vi.mock('@/lib/supabase/client', () => ({
  supabaseConfigured: () => {
    if (fails.configured) throw new Error('the configuration could not be read');
    return true;
  },
  anonClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q['select'] = () => q;
      q['in'] = (_col: string, ids: string[]) => {
        asked.push(ids);
        return q;
      };
      q['then'] = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ data: rows, error }));
      return q;
    },
  }),
}));

const { getSectionImages } = await import('@/lib/data/sectionMedia');

const IA = '5eed0a00-0000-4000-8000-000000000007';
const IB = '5eed0a00-0000-4000-8000-000000000008';
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'image',
  provider: 'static',
  storage_path: 'stills/work/ia.jpg',
  width: 1280,
  height: 720,
  alt: { en: 'A frame', ar: 'لقطة' },
  stream_uid: null,
  ...over,
});

beforeEach(() => {
  rows = [];
  error = null;
  asked.length = 0;
  fails.scope = false;
  fails.configured = false;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('getSectionImages', () => {
  it('resolves the ids it is given, keyed by id', async () => {
    rows = [row(IA)];
    const images = await getSectionImages([IA]);
    expect([...images.keys()]).toEqual([IA]);
    expect(images.get(IA)?.width).toBe(1280);
    expect(images.get(IA)?.alt).toEqual({ en: 'A frame', ar: 'لقطة' });
  });

  it('asks only for well-formed, distinct ids — and nothing at all when none are', async () => {
    await getSectionImages([IA, IA, 'not-a-uuid', "'; drop table media_assets; --"]);
    expect(asked).toEqual([[IA]]);
    asked.length = 0;
    expect((await getSectionImages(['nope'])).size).toBe(0);
    expect(asked).toEqual([]);
  });

  it('drops rows the public image gate refuses (non-static provider, unknown key)', async () => {
    rows = [row(IA, { provider: 'external' }), row(IB, { storage_path: 'stills/work/zz.jpg' })];
    expect((await getSectionImages([IA, IB])).size).toBe(0);
  });

  it('fails closed to an empty map on a query error', async () => {
    error = { code: '42501' };
    rows = [row(IA)];
    expect((await getSectionImages([IA])).size).toBe(0);
  });

  it('a page scope that throws is an empty map, never a throw (CR3)', async () => {
    fails.scope = true;
    rows = [row(IA)];
    const images = getSectionImages([IA]);
    await expect(images).resolves.toBeInstanceOf(Map);
    expect((await images).size).toBe(0);
    expect(asked).toEqual([]);
  });

  it('a configuration check that throws is an empty map too (CR3)', async () => {
    fails.configured = true;
    rows = [row(IA)];
    const images = getSectionImages([IA]);
    await expect(images).resolves.toBeInstanceOf(Map);
    expect((await images).size).toBe(0);
    expect(asked).toEqual([]);
  });
});
