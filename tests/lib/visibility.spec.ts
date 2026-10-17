import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_VISIBILITY,
  VISIBILITY_KV_KEY,
  VISIBILITY_MEMO_MS,
  clearVisibilityMemo,
  decide,
  effectiveMode,
  getVisibilitySnapshot,
  hasRestrictions,
  isListed,
  modeOf,
  parseVisibilitySnapshot,
  visibilityRevision,
  putVisibilitySnapshot,
  type VisibilitySnapshot,
} from '@/lib/http/visibility';
import {
  filterNavForVisibility,
  isListedPath,
  listedSearchHits,
  logicalPathOfHref,
} from '@/lib/visibility/listing';
import {
  PAGE_NOTE_MAX,
  PagePasswordWriteSchema,
  PageVisibilityWriteSchema,
  VISIBILITY_MODES,
  VISIBILITY_WRITE_MODES,
  passwordBytes,
  riyadhDayOf,
  riyadhMidnight,
} from '@schemas/visibility';
import { env as stubEnv, __kv } from '../stubs/cloudflare-workers';

/** The stub, typed as the binding the module reads (it implements the methods used). */
const env = stubEnv as unknown as { SESSION: KVNamespace };

// Page visibility's edge half (Admin v2 U14a): the snapshot as the middleware reads it, what
// a request gets for each mode and window, the menus' filter, and the drawer's schema.

const FROM = '2026-11-01T00:00:00+03:00';
const UNTIL = '2026-11-08T00:00:00+03:00';
const at = (iso: string) => Date.parse(iso);
/** A moment outside every window these tests use. */
const NOW = at('2026-10-17T09:00:00+03:00');

const snap = (over: Partial<VisibilitySnapshot> = {}): VisibilitySnapshot => ({
  v: 1,
  builtAt: '2026-10-16T09:00:00.000Z',
  pages: {},
  templates: {},
  ...over,
});

beforeEach(() => {
  __kv.clear();
  clearVisibilityMemo();
});

describe('effectiveMode: hidden only inside [from, until)', () => {
  const hidden = { mode: 'hidden' as const, target: null, from: FROM, until: UNTIL };

  it('is public before the window, hidden from its first instant, public again at its end', () => {
    expect(effectiveMode(hidden, at(FROM) - 1)).toBe('public');
    expect(effectiveMode(hidden, at(FROM))).toBe('hidden');
    expect(effectiveMode(hidden, at(UNTIL) - 1)).toBe('hidden');
    expect(effectiveMode(hidden, at(UNTIL))).toBe('public');
  });

  it('an open end is open: no from is hidden until the end, no until is hidden for good', () => {
    expect(effectiveMode({ mode: 'hidden', until: UNTIL }, 0)).toBe('hidden');
    expect(effectiveMode({ mode: 'hidden', from: FROM }, at(UNTIL) * 2)).toBe('hidden');
    expect(effectiveMode({ mode: 'hidden' }, 0)).toBe('hidden');
  });

  it('link only has no window, and no entry is public', () => {
    expect(effectiveMode({ mode: 'link' }, 0)).toBe('link');
    expect(effectiveMode(undefined, 0)).toBe('public');
  });
});

describe('decide', () => {
  const now = at('2026-11-03T12:00:00+03:00');

  it('passes a public page, unlists a link-only one, hides a hidden one', () => {
    const s = snap({
      pages: { about: { mode: 'link' }, join: { mode: 'hidden', target: 'contact' } },
    });
    expect(decide(s, { kind: 'page', slug: 'contact' }, now)).toEqual({ action: 'pass' });
    expect(decide(s, { kind: 'page', slug: 'about' }, now)).toEqual({ action: 'noindex' });
    expect(decide(s, { kind: 'page', slug: 'join' }, now)).toEqual({
      action: 'hide',
      to: 'contact',
    });
  });

  it('a redirect to a page that is itself hidden is a 404: no chains, no loops', () => {
    const s = snap({
      pages: {
        about: { mode: 'hidden', target: 'join' },
        join: { mode: 'hidden', target: 'about' },
      },
    });
    expect(decide(s, { kind: 'page', slug: 'about' }, now)).toEqual({ action: 'hide', to: null });
    expect(decide(s, { kind: 'page', slug: 'join' }, now)).toEqual({ action: 'hide', to: null });
  });

  it('a redirect to a link-only page is followed (its link works), to itself is a 404', () => {
    const s = snap({
      pages: { about: { mode: 'hidden', target: 'join' }, join: { mode: 'link' } },
    });
    expect(decide(s, { kind: 'page', slug: 'about' }, now)).toEqual({ action: 'hide', to: 'join' });
    const self = snap({ pages: { about: { mode: 'hidden', target: 'about' } } });
    expect(decide(self, { kind: 'page', slug: 'about' }, now)).toEqual({
      action: 'hide',
      to: null,
    });
  });

  it('a target hidden only later is followed now', () => {
    const s = snap({
      pages: {
        about: { mode: 'hidden', target: 'join' },
        join: { mode: 'hidden', from: '2026-12-01T00:00:00+03:00' },
      },
    });
    expect(decide(s, { kind: 'page', slug: 'about' }, now)).toEqual({ action: 'hide', to: 'join' });
  });

  it('the homepage always passes, whatever a snapshot says', () => {
    const s = { ...snap(), pages: { home: { mode: 'hidden' as const, target: null } } };
    expect(decide(s, { kind: 'page', slug: 'home' }, now)).toEqual({ action: 'pass' });
  });

  it('a hidden template hides every page it renders; a redirect from it is followed', () => {
    const s = snap({ templates: { service: { mode: 'hidden', target: 'services' } } });
    expect(decide(s, { kind: 'template', template: 'service' }, now)).toEqual({
      action: 'hide',
      to: 'services',
    });
    expect(decide(s, { kind: 'template', template: 'case_study' }, now)).toEqual({
      action: 'pass',
    });
  });

  it('outside its window a hidden page passes', () => {
    const s = snap({
      pages: { about: { mode: 'hidden', target: null, from: FROM, until: UNTIL } },
    });
    expect(decide(s, { kind: 'page', slug: 'about' }, at(UNTIL))).toEqual({ action: 'pass' });
    expect(decide(s, { kind: 'page', slug: 'about' }, now)).toEqual({ action: 'hide', to: null });
  });
});

describe('parseVisibilitySnapshot: anything unreadable is every page public', () => {
  it('reads a snapshot', () => {
    const raw = JSON.stringify(
      snap({
        pages: { about: { mode: 'hidden', target: 'contact', from: FROM } },
        templates: { case_study: { mode: 'hidden', target: null } },
      }),
    );
    const parsed = parseVisibilitySnapshot(raw);
    expect(parsed.pages.about).toEqual({ mode: 'hidden', target: 'contact', from: FROM });
    expect(parsed.templates.case_study).toEqual({ mode: 'hidden', target: null });
    expect(parsed.builtAt).toBe('2026-10-16T09:00:00.000Z');
  });

  it('drops what it cannot use: bad JSON, another version, unknown pages, the homepage, bad modes', () => {
    for (const raw of [null, '', '{{{', '[]', '"x"', JSON.stringify({ v: 2, pages: {} })]) {
      expect(parseVisibilitySnapshot(raw), String(raw)).toEqual(EMPTY_VISIBILITY);
    }
    const parsed = parseVisibilitySnapshot(
      JSON.stringify({
        v: 1,
        pages: {
          home: { mode: 'hidden' },
          constructor: { mode: 'hidden' },
          careers: { mode: 'hidden' },
          about: { mode: 'secret' },
          join: { mode: 'link', target: 'contact', from: FROM },
          contact: { mode: 'hidden', target: 'nowhere', from: 'soon' },
        },
        templates: { service: { mode: 'link' }, blog: { mode: 'hidden' } },
      }),
    );
    expect(parsed.pages).toEqual({
      join: { mode: 'link' },
      contact: { mode: 'hidden', target: null },
    });
    expect(parsed.templates).toEqual({});
  });

  it('keeps the revision the admin compares, and drops one that is not a bounded string', () => {
    const base = { v: 1, builtAt: null, pages: {}, templates: {} };
    expect(parseVisibilitySnapshot(JSON.stringify({ ...base, rev: 'a:1,b:2' })).rev).toBe(
      'a:1,b:2',
    );
    expect(parseVisibilitySnapshot(JSON.stringify({ ...base, rev: 7 })).rev).toBeUndefined();
    expect(
      parseVisibilitySnapshot(JSON.stringify({ ...base, rev: 'x'.repeat(20_000) })).rev,
    ).toBeUndefined();
    expect(
      visibilityRevision([
        { id: 'b', version: 2 },
        { id: 'a', version: 1 },
      ]),
    ).toBe('a:1,b:2');
    expect(visibilityRevision([])).toBe('');
  });

  it('hasRestrictions is false for no snapshot and for an empty one', () => {
    expect(hasRestrictions(undefined)).toBe(false);
    expect(hasRestrictions(EMPTY_VISIBILITY)).toBe(false);
    expect(hasRestrictions(snap({ pages: { about: { mode: 'link' } } }))).toBe(true);
  });
});

describe('the isolate memo', () => {
  const hidden = snap({ pages: { about: { mode: 'hidden', target: null } } });

  it('reads KV once a minute, not once a request', async () => {
    __kv.set(VISIBILITY_KV_KEY, JSON.stringify(hidden));
    const get = vi.spyOn(env.SESSION, 'get');
    const t0 = 1_000_000;
    expect((await getVisibilitySnapshot(env, t0)).pages.about?.mode).toBe('hidden');
    await getVisibilitySnapshot(env, t0 + 1);
    await getVisibilitySnapshot(env, t0 + VISIBILITY_MEMO_MS - 1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(VISIBILITY_KV_KEY, { cacheTtl: 60 });
    __kv.set(VISIBILITY_KV_KEY, JSON.stringify(snap()));
    expect((await getVisibilitySnapshot(env, t0 + VISIBILITY_MEMO_MS)).pages).toEqual({});
    expect(get).toHaveBeenCalledTimes(2);
    get.mockRestore();
  });

  it('a write refreshes the writer’s own memo at once (write-through)', async () => {
    const t0 = 2_000_000;
    expect(await getVisibilitySnapshot(env, t0)).toEqual(EMPTY_VISIBILITY);
    expect(await putVisibilitySnapshot(env, hidden, t0 + 5)).toBe(true);
    expect(JSON.parse(__kv.get(VISIBILITY_KV_KEY)!)).toEqual(hidden);
    const get = vi.spyOn(env.SESSION, 'get');
    expect((await getVisibilitySnapshot(env, t0 + 10)).pages.about?.mode).toBe('hidden');
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });

  it('fails open: a KV error keeps the last good snapshot, or none, and waits out the minute', async () => {
    const t0 = 3_000_000;
    __kv.set(VISIBILITY_KV_KEY, JSON.stringify(hidden));
    await getVisibilitySnapshot(env, t0);
    const get = vi.spyOn(env.SESSION, 'get').mockRejectedValue(new Error('kv down'));
    const later = await getVisibilitySnapshot(env, t0 + VISIBILITY_MEMO_MS);
    expect(later.pages.about?.mode).toBe('hidden');
    await getVisibilitySnapshot(env, t0 + VISIBILITY_MEMO_MS + 1);
    expect(get).toHaveBeenCalledTimes(1);
    clearVisibilityMemo();
    expect(await getVisibilitySnapshot(env, t0)).toEqual(EMPTY_VISIBILITY);
    get.mockRestore();
  });

  it('a write that fails reports it and leaves the memo alone', async () => {
    const put = vi.spyOn(env.SESSION, 'put').mockRejectedValue(new Error('kv down'));
    expect(await putVisibilitySnapshot(env, hidden, 4_000_000)).toBe(false);
    expect(await getVisibilitySnapshot(env, 4_000_001)).toEqual(EMPTY_VISIBILITY);
    put.mockRestore();
    expect(await putVisibilitySnapshot({}, hidden)).toBe(false);
  });
});

describe('what is listed (menus, sitemap, llms.txt, search)', () => {
  const now = at('2026-11-03T12:00:00+03:00');
  const s = snap({
    pages: {
      about: { mode: 'link' },
      join: { mode: 'hidden', target: null, from: FROM, until: UNTIL },
    },
    templates: { service: { mode: 'hidden', target: null } },
  });

  it('only a public page is listed: link only and hidden are not, a path nobody owns is', () => {
    expect(isListedPath(s, '/contact', now)).toBe(true);
    expect(isListedPath(s, '/about', now)).toBe(false);
    expect(isListedPath(s, '/join', now)).toBe(false);
    expect(isListedPath(s, '/join', at(UNTIL))).toBe(true);
    expect(isListedPath(s, '/services', now)).toBe(true);
    expect(isListedPath(s, '/services/logo', now)).toBe(false);
    expect(isListedPath(s, '/portfolio/the-rider', now)).toBe(true);
    expect(isListedPath(s, '/privacy', now)).toBe(true);
    expect(isListed(undefined, { kind: 'page', slug: 'about' }, now)).toBe(true);
  });

  it('reads hrefs as the menus hold them', () => {
    expect(logicalPathOfHref('/ar/about?x=1#y')).toBe('/about');
    expect(logicalPathOfHref('/#services')).toBe('/');
    expect(logicalPathOfHref('/ar')).toBe('/');
    for (const href of [
      'https://x.test/about',
      'mailto:a@b.c',
      '#top',
      '//host/about',
      '/\\host',
    ]) {
      expect(logicalPathOfHref(href), href).toBeNull();
    }
  });

  interface Item {
    id: string;
    href: string;
    children: Item[];
  }
  const node = (href: string, children: Item[] = []): Item => ({ id: href, href, children });

  it('the menu filter drops unlisted items, with their children, and keeps the rest in order', () => {
    const nav = [
      node('/'),
      node('/about', [node('/contact')]),
      node('/services', [node('/services/logo'), node('/services/hosting')]),
      node('/ar/join'),
      node('https://elsewhere.test/'),
      node('/contact'),
    ];
    expect(
      filterNavForVisibility(nav, s, now).map((n) => [n.href, n.children.map((c) => c.href)]),
    ).toEqual([
      ['/', []],
      ['/services', []],
      ['https://elsewhere.test/', []],
      ['/contact', []],
    ]);
  });

  it('with nothing restricted it returns the very same list (no byte can move)', () => {
    const nav = [node('/'), node('/about')];
    expect(filterNavForVisibility(nav, undefined, now)).toBe(nav);
    expect(filterNavForVisibility(nav, EMPTY_VISIBILITY, now)).toBe(nav);
  });
});

describe('the public search', () => {
  const hit = (entity_type: 'service' | 'portfolio' | 'blog', slug: string) => ({
    entity_type,
    slug,
    title: { en: slug },
    snippet: null,
    rank: 1,
  });
  const hits = [hit('service', 'logo'), hit('portfolio', 'the-rider'), hit('blog', 'arabic')];

  it('drops the hits under a hidden template, and only those', () => {
    const s = snap({ templates: { service: { mode: 'hidden', target: null } } });
    expect(listedSearchHits(hits, s, 0).map((h) => h.slug)).toEqual(['the-rider', 'arabic']);
    const both = snap({
      templates: {
        service: { mode: 'hidden', target: null },
        case_study: { mode: 'hidden', target: null },
      },
    });
    expect(listedSearchHits(hits, both, 0).map((h) => h.slug)).toEqual(['arabic']);
  });

  it('with nothing restricted returns the very same list', () => {
    expect(listedSearchHits(hits, EMPTY_VISIBILITY, 0)).toBe(hits);
    expect(listedSearchHits(hits, snap({ pages: { about: { mode: 'link' } } }), 0)).toEqual(hits);
  });
});

describe('the drawer’s schema (packages/schemas/visibility.ts)', () => {
  const base = { target: { pageId: '11111111-1111-4111-8111-111111111111' }, version: 0 };

  it('stores a Riyadh day as its midnight in Riyadh, and reads it back', () => {
    expect(riyadhMidnight('2026-11-01')).toBe('2026-10-31T21:00:00.000Z');
    expect(riyadhDayOf('2026-10-31T21:00:00.000Z')).toBe('2026-11-01');
    expect(riyadhDayOf('2026-11-01T20:59:59.000Z')).toBe('2026-11-01');
    expect(riyadhDayOf('nonsense')).toBeNull();
  });

  it('accepts each mode, with the hidden extras only on hidden', () => {
    expect(PageVisibilityWriteSchema.safeParse({ ...base, mode: 'public' }).success).toBe(true);
    expect(PageVisibilityWriteSchema.safeParse({ ...base, mode: 'link' }).success).toBe(true);
    expect(
      PageVisibilityWriteSchema.safeParse({
        ...base,
        mode: 'hidden',
        redirectPageId: '22222222-2222-4222-8222-222222222222',
        hideFrom: '2026-11-01',
        showOn: '2026-11-08',
      }).success,
    ).toBe(true);
    for (const extra of [
      { redirectPageId: '22222222-2222-4222-8222-222222222222' },
      { hideFrom: '2026-11-01' },
      { showOn: '2026-11-08' },
    ]) {
      expect(PageVisibilityWriteSchema.safeParse({ ...base, mode: 'link', ...extra }).success).toBe(
        false,
      );
    }
  });

  it('refuses a window out of order, a day that does not exist, a link-only template, unknown keys', () => {
    for (const bad of [
      { ...base, mode: 'hidden', hideFrom: '2026-11-08', showOn: '2026-11-08' },
      { ...base, mode: 'hidden', hideFrom: '2026-02-30' },
      { target: { template: 'service' }, mode: 'link', version: 0 },
      { target: { template: 'blog' }, mode: 'hidden', version: 0 },
      { ...base, mode: 'public', version: -1 },
      { ...base, mode: 'public', note: 'x' },
      { target: { pageId: 'x', template: 'service' }, mode: 'public', version: 0 },
    ]) {
      expect(PageVisibilityWriteSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('a page behind a password (U14b)', () => {
  const PAGE_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  const locked = (over: Record<string, unknown> = {}) => ({
    v: 1 as const,
    builtAt: null,
    pages: { about: { mode: 'password' as const, id: PAGE_ID, pv: 2, ...over } },
    templates: {},
  });

  it('decide answers the gate with what the box needs, and never a secret', () => {
    const snap = locked({ note: { en: 'Ask the studio.', ar: 'اسأل الاستوديو.' } });
    const gate = decide(snap, { kind: 'page', slug: 'about' }, NOW);
    expect(gate).toEqual({
      action: 'password',
      id: PAGE_ID,
      pv: 2,
      note: { en: 'Ask the studio.', ar: 'اسأل الاستوديو.' },
    });
  });

  it('a password page is never listed, and never public', () => {
    const snap = locked();
    expect(modeOf(snap, { kind: 'page', slug: 'about' }, NOW)).toBe('password');
    expect(isListed(snap, { kind: 'page', slug: 'about' }, NOW)).toBe(false);
    // No window: the dates belong to `hidden` alone (0057's CHECK).
    expect(effectiveMode(snap.pages.about, NOW + 10 * 365 * 24 * 3600 * 1000)).toBe('password');
  });

  it('a hidden page may be sent to a password page: a working link, never a chain', () => {
    const snap = {
      v: 1 as const,
      builtAt: null,
      pages: {
        join: { mode: 'hidden' as const, target: 'about' as const },
        about: { mode: 'password' as const, id: PAGE_ID, pv: 1 },
      },
      templates: {},
    };
    expect(decide(snap, { kind: 'page', slug: 'join' }, NOW)).toEqual({
      action: 'hide',
      to: 'about',
    });
  });

  it('reads a stored entry back whole: the id, the version and a plain message', () => {
    const snap = parseVisibilitySnapshot(
      JSON.stringify({
        v: 1,
        builtAt: null,
        tenant: '11111111-1111-4111-8111-111111111111',
        pages: { about: { mode: 'password', id: PAGE_ID, pv: 9, note: { en: 'Ask.' } } },
        templates: {},
      }),
    );
    expect(snap.tenant).toBe('11111111-1111-4111-8111-111111111111');
    expect(snap.pages.about).toEqual({
      mode: 'password',
      id: PAGE_ID,
      pv: 9,
      note: { en: 'Ask.' },
    });
  });

  it('a message that is markup, blank or too long is dropped, never rendered', () => {
    const note = (value: unknown) =>
      parseVisibilitySnapshot(
        JSON.stringify({
          v: 1,
          builtAt: null,
          pages: { about: { mode: 'password', id: PAGE_ID, pv: 1, note: value } },
          templates: {},
        }),
      ).pages.about?.note;
    expect(note({ en: '<b>hi</b>' })).toBeUndefined();
    expect(note({ en: '   ' })).toBeUndefined();
    expect(note({ en: 'a'.repeat(141) })).toBeUndefined();
    expect(note({ en: 'ok', ar: '<i>x</i>' })).toEqual({ en: 'ok' });
    expect(note('a string')).toBeUndefined();
  });

  it('an entry that cannot be unlocked becomes a 404, never a public page', () => {
    for (const broken of [
      { mode: 'password' },
      { mode: 'password', id: PAGE_ID },
      { mode: 'password', id: 'not-a-uuid', pv: 1 },
      { mode: 'password', id: PAGE_ID, pv: 0 },
      { mode: 'password', id: PAGE_ID, pv: 'two' },
    ]) {
      const snap = parseVisibilitySnapshot(
        JSON.stringify({ v: 1, builtAt: null, pages: { about: broken }, templates: {} }),
      );
      expect(snap.pages.about, JSON.stringify(broken)).toEqual({ mode: 'hidden', target: null });
      expect(decide(snap, { kind: 'page', slug: 'about' }, NOW)).toEqual({
        action: 'hide',
        to: null,
      });
    }
  });

  it('a template is never a password page, whatever a snapshot says', () => {
    const snap = parseVisibilitySnapshot(
      JSON.stringify({
        v: 1,
        builtAt: null,
        pages: {},
        templates: { service: { mode: 'password', id: PAGE_ID, pv: 1 } },
      }),
    );
    expect(snap.templates).toEqual({});
  });

  it('a tenant that is not a uuid is left out, so nothing binds to it', () => {
    const snap = parseVisibilitySnapshot(
      JSON.stringify({ v: 1, builtAt: null, tenant: 'nope', pages: {}, templates: {} }),
    );
    expect(snap.tenant).toBeUndefined();
  });
});

describe('the password door’s schema (packages/schemas/visibility.ts)', () => {
  const base = {
    pageId: '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    password: 'letmein22',
    note: null,
    version: 0,
  };

  it('takes a page, a password and an optional message in either language', () => {
    expect(PagePasswordWriteSchema.safeParse(base).success).toBe(true);
    expect(
      PagePasswordWriteSchema.safeParse({ ...base, note: { en: 'Ask the studio.' } }).success,
    ).toBe(true);
    expect(PagePasswordWriteSchema.safeParse({ ...base, note: { ar: 'اسأل.' } }).success).toBe(
      true,
    );
  });

  it('measures the password in bytes, as bcrypt reads it', () => {
    expect(passwordBytes('letmein22')).toBe(9);
    expect(passwordBytes('ا'.repeat(37))).toBe(74);
    expect(PagePasswordWriteSchema.safeParse({ ...base, password: 'short7' }).success).toBe(false);
    expect(PagePasswordWriteSchema.safeParse({ ...base, password: 'ا'.repeat(37) }).success).toBe(
      false,
    );
    expect(PagePasswordWriteSchema.safeParse({ ...base, password: 'ا'.repeat(36) }).success).toBe(
      true,
    );
  });

  it('refuses a message that is markup, blank, too long, empty or in another language', () => {
    for (const note of [
      { en: '<b>hi</b>' },
      { en: '   ' },
      { en: 'a'.repeat(PAGE_NOTE_MAX + 1) },
      {},
      { fr: 'ouvrez' },
      'a string',
    ]) {
      expect(PagePasswordWriteSchema.safeParse({ ...base, note }).success, String(note)).toBe(
        false,
      );
    }
  });

  it('refuses an unknown key and a missing version', () => {
    expect(PagePasswordWriteSchema.safeParse({ ...base, mode: 'password' }).success).toBe(false);
    expect(PagePasswordWriteSchema.safeParse({ ...base, version: undefined }).success).toBe(false);
  });

  it('the list’s save takes no password mode: it has no password to set', () => {
    expect(
      PageVisibilityWriteSchema.safeParse({
        target: { pageId: base.pageId },
        mode: 'password',
        version: 0,
      }).success,
    ).toBe(false);
    expect(VISIBILITY_WRITE_MODES).toEqual(['public', 'hidden', 'link']);
    expect(VISIBILITY_MODES).toEqual(['public', 'hidden', 'link', 'password']);
  });
});
