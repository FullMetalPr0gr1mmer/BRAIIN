import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDENTITY_FALLBACK } from '@/lib/identity/fallback';

// loadHead exists to keep a Tier-A page's head reads in ONE round-trip: chaining them
// (identity, then defaults, then the entity override) doubled TTFB on the preview. These
// tests hold every read open and assert they were all STARTED before any finished.

const started: string[] = [];
const gates: Record<string, (v: unknown) => void> = {};
const hold = (name: string, value: unknown) =>
  new Promise((resolve) => {
    started.push(name);
    gates[name] = () => resolve(value);
  });

vi.mock('@/lib/data/siteProfile', () => ({
  getSiteProfile: vi.fn(() => hold('identity', IDENTITY_FALLBACK)),
}));
vi.mock('@/lib/data/seo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/data/seo')>();
  return {
    ...actual,
    getSeoDefaults: vi.fn(() => hold('defaults', null)),
    getEntitySeo: vi.fn((type: string, id: string) =>
      hold(`entity:${type}:${id}`, {
        meta_title: { en: 'Override', ar: 'تجاوز' },
        meta_description: null,
        og_image: null,
        canonical_override: null,
        robots: null,
        schema_type: null,
      }),
    ),
  };
});

const { loadHead } = await import('@/lib/seo/head');
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  started.length = 0;
  for (const k of Object.keys(gates)) delete gates[k];
});

describe('loadHead', () => {
  it('starts the identity, defaults and entity reads together, not in turn', async () => {
    const head = loadHead(
      {},
      {
        locale: 'en',
        fallbackTitle: 'Branding',
        entity: { type: 'service', id: 's1' },
      },
    );
    await tick();
    expect(started.sort()).toEqual(['defaults', 'entity:service:s1', 'identity']);
    for (const open of Object.values(gates)) open(undefined);
    const { seo, brand } = await head;
    expect(brand).toBe('Braiin Statiion');
    expect(seo.title).toBe('Braiin Statiion | Override');
  });

  it('accepts the page reference as a promise and still overlaps the other reads', async () => {
    let resolvePage!: (v: { type: 'page'; id: string } | null) => void;
    const page = new Promise<{ type: 'page'; id: string } | null>((r) => (resolvePage = r));
    const head = loadHead({}, { locale: 'ar', fallbackTitle: 'من نحن', entity: page });
    await tick();
    // identity + defaults are already in flight while the composition query runs
    expect(started.sort()).toEqual(['defaults', 'identity']);
    resolvePage({ type: 'page', id: 'p1' });
    await tick();
    expect(started).toContain('entity:page:p1');
    for (const open of Object.values(gates)) open(undefined);
    expect((await head).seo.title).toBe('بريّن ستيشن | تجاوز');
  });

  it('skips the entity read when the page has no row, and falls back to the page title', async () => {
    const head = loadHead(
      {},
      { locale: 'en', fallbackTitle: 'About', entity: Promise.resolve(null) },
    );
    await tick();
    expect(started.sort()).toEqual(['defaults', 'identity']);
    for (const open of Object.values(gates)) open(undefined);
    expect((await head).seo.title).toBe('Braiin Statiion | About');
  });

  it('shares the identity with later callers on the same request (header, footer, head)', async () => {
    const locals: { identity?: Promise<typeof IDENTITY_FALLBACK> } = {};
    const head = loadHead(locals, { locale: 'en', fallbackTitle: 'X' });
    await tick();
    for (const open of Object.values(gates)) open(undefined);
    const { identity } = await head;
    expect(await locals.identity).toBe(identity);
    expect(started.filter((s) => s === 'identity')).toHaveLength(1);
  });

  // UI v2 PR11: the case study only learns its title and blurb from the content query it
  // starts alongside the head, so both fallbacks may be promises too.
  it('accepts the fallback title and description as promises, still in one round', async () => {
    let resolveStudy!: (v: { title: string; description: string }) => void;
    const study = new Promise<{ title: string; description: string }>((r) => (resolveStudy = r));
    const head = loadHead(
      {},
      {
        locale: 'en',
        fallbackTitle: study.then((s) => s.title),
        fallbackDescription: study.then((s) => s.description),
        entity: study.then(() => null),
      },
    );
    await tick();
    expect(started.sort()).toEqual(['defaults', 'identity']);
    resolveStudy({ title: 'The Rider | Brand film', description: 'A launch film.' });
    for (const open of Object.values(gates)) open(undefined);
    const { seo } = await head;
    expect(seo.title).toBe('Braiin Statiion | The Rider | Brand film');
    expect(seo.description).toBe('A launch film.');
  });
});
