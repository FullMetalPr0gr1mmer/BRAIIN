import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  REDIRECTS_KV_KEY,
  REDIRECT_CACHE_CONTROL,
  REDIRECT_MAP_CACHE_TTL_S,
  RESERVED_REDIRECT_PREFIXES,
  TEMPORARY_REDIRECT_CACHE_CONTROL,
  buildRedirectMap,
  getRedirectMap,
  isReservedRedirectPath,
  lookupRedirect,
  normalizeRedirectPath,
  parseRedirectMap,
  putRedirectMap,
  redirectLocation,
  redirectResponse,
  sitePathOf,
  targetPathOf,
  type RedirectMap,
} from '@/lib/http/redirects';
import { RETIRED_CACHE_CONTROL } from '@/lib/services/retired';
import { env as stubEnv, __kv } from '../stubs/cloudflare-workers';

/** The stub as the module types its parameter (tsc sees the real KVNamespace here). */
const env = stubEnv as unknown as { SESSION?: KVNamespace };

// The edge half of the redirects module (Round 3, item A). Pure functions plus the KV
// round-trip through the in-memory stub — the same store the middleware and the admin
// sync read and write in their own specs.

const rule = (to: string, status: 301 | 302 | 308 = 301) => ({ to, status });

beforeEach(() => {
  __kv.clear();
});

describe('normalizeRedirectPath', () => {
  it('drops ONE trailing slash and keeps the root', () => {
    expect(normalizeRedirectPath('/old/')).toBe('/old');
    expect(normalizeRedirectPath('/old')).toBe('/old');
    expect(normalizeRedirectPath('/')).toBe('/');
    expect(normalizeRedirectPath('')).toBe('/');
    expect(normalizeRedirectPath('  /old/  ')).toBe('/old');
  });

  it('is idempotent', () => {
    for (const p of ['/a/b/', '/a/b', '/', '/عن', '/a%20b']) {
      expect(normalizeRedirectPath(normalizeRedirectPath(p))).toBe(normalizeRedirectPath(p));
    }
  });

  it('canonicalises to the percent-encoded spelling the request carries', () => {
    // An editor types `/عن`; the browser sends `/%D8%B9%D9%86`. One key for both, or an
    // Arabic source could never match (review finding 4).
    expect(normalizeRedirectPath('/عن')).toBe('/%D8%B9%D9%86');
    expect(normalizeRedirectPath('/%D8%B9%D9%86')).toBe('/%D8%B9%D9%86');
    expect(normalizeRedirectPath('/ar/عن/')).toBe('/ar/%D8%B9%D9%86');
    expect(normalizeRedirectPath('/a b')).toBe('/a%20b');
    expect(normalizeRedirectPath('/a%20b')).toBe('/a%20b');
    expect(normalizeRedirectPath('/a/./b/../c/')).toBe('/a/c');
  });

  it('drops a query or fragment (they never belong in a key) and keeps case', () => {
    expect(normalizeRedirectPath('/old?x=1#top')).toBe('/old');
    expect(normalizeRedirectPath('/Old')).toBe('/Old');
  });
});

describe('sitePathOf / targetPathOf', () => {
  it('is the canonical pathname of a site-relative reference', () => {
    expect(sitePathOf('/new/')).toBe('/new/');
    expect(sitePathOf('/new?x=1#top')).toBe('/new');
    expect(targetPathOf('/new')).toBe('/new');
    expect(targetPathOf('/new/')).toBe('/new');
    expect(targetPathOf('/new?x=1#top')).toBe('/new');
    expect(targetPathOf('/services#branding')).toBe('/services');
  });

  it('is null for a reference that is not a site path or resolves off the site', () => {
    // WHATWG reads a backslash as a slash in an https URL: `/\host/x` IS `//host/x`.
    for (const ref of [
      'https://example.test/x',
      '//example.test/x',
      '/\\evil.test/x',
      '/\\\\evil.test',
      'relative',
      '',
    ]) {
      expect(sitePathOf(ref), ref).toBeNull();
      expect(targetPathOf(ref), ref).toBeNull();
    }
  });
});

describe('isReservedRedirectPath', () => {
  it('claims the CMS, its API, the health probe and the asset routes', () => {
    for (const p of [
      '/admin',
      '/admin/',
      '/admin/services',
      '/api/admin/redirects',
      '/api/contact',
      '/healthz',
      '/_astro/x.js',
      '/_image',
      '/_image/x',
      '/media/showreel.mp4',
      '/fonts/a.woff2',
      '/styles/global.css',
    ]) {
      expect(isReservedRedirectPath(p), p).toBe(true);
    }
  });

  it('does not over-match a public path that merely starts with the same letters', () => {
    for (const p of ['/administration', '/apis', '/healthzz', '/mediation', '/about', '/']) {
      expect(isReservedRedirectPath(p), p).toBe(false);
    }
  });

  it('the prefix list is the documented one (CLAUDE.md §8)', () => {
    expect(RESERVED_REDIRECT_PREFIXES).toEqual([
      '/admin',
      '/api/',
      '/healthz',
      '/_astro/',
      '/_image',
      '/media/',
      '/fonts/',
      '/styles/',
    ]);
  });
});

describe('buildRedirectMap', () => {
  it('normalises keys, coerces status and keeps targets verbatim', () => {
    const map = buildRedirectMap([
      { source_path: '/old/', target_path: '/new', status: 302 },
      { source_path: '/x', target_path: 'https://example.test/y', status: 307 },
    ]);
    expect(map).toEqual({ '/old': rule('/new', 302), '/x': rule('https://example.test/y') });
  });

  it('drops reserved sources even when the row exists in the table', () => {
    const map = buildRedirectMap([
      { source_path: '/admin/login', target_path: '/evil', status: 301 },
      { source_path: '/api/contact', target_path: '/evil', status: 301 },
      { source_path: '/healthz', target_path: '/evil', status: 301 },
      { source_path: '/ok', target_path: '/fine', status: 301 },
    ]);
    expect(Object.keys(map)).toEqual(['/ok']);
  });

  it('first row wins when two rows differ only by a trailing slash', () => {
    const map = buildRedirectMap([
      { source_path: '/a', target_path: '/first', status: 301 },
      { source_path: '/a/', target_path: '/second', status: 301 },
    ]);
    expect(map['/a']).toEqual(rule('/first'));
  });

  it('drops rows with no usable source or target rather than throwing', () => {
    const map = buildRedirectMap([
      { source_path: null, target_path: '/x' },
      { source_path: '/a', target_path: '' },
      { source_path: 'relative', target_path: '/x' },
      { source_path: '/b', target_path: 42 },
    ]);
    expect(map).toEqual({});
  });

  it('drops a "site-relative" target or source that resolves off the site', () => {
    // The schema refuses these on write; the map refuses them again because the map is
    // what the edge serves, whatever path a row took into the table.
    const map = buildRedirectMap([
      { source_path: '/a', target_path: '/\\evil.test/x' },
      { source_path: '/b', target_path: '//evil.test/x' },
      { source_path: '//evil.test/c', target_path: '/fine' },
      { source_path: '/\\evil.test/d', target_path: '/fine' },
      { source_path: '/ok', target_path: '/fine' },
      { source_path: '/abs', target_path: 'https://example.test/y' },
    ]);
    expect(Object.keys(map)).toEqual(['/ok', '/abs']);
  });

  it('keys an Arabic source by its percent-encoded spelling', () => {
    const map = buildRedirectMap([{ source_path: '/عن', target_path: '/about' }]);
    expect(Object.keys(map)).toEqual(['/%D8%B9%D9%86']);
  });
});

describe('parseRedirectMap', () => {
  it('reads a snapshot and defaults an unknown status to 301', () => {
    const map = parseRedirectMap(JSON.stringify({ '/a': { to: '/b', status: 'bogus' } }));
    expect(map).toEqual({ '/a': rule('/b') });
  });

  it('is empty for null, malformed JSON, arrays and non-object rules', () => {
    expect(parseRedirectMap(null)).toEqual({});
    expect(parseRedirectMap('{{{')).toEqual({});
    expect(parseRedirectMap('[1]')).toEqual({});
    expect(parseRedirectMap(JSON.stringify({ '/a': 'nope', '/b': { status: 301 } }))).toEqual({});
  });

  it('ignores keys that are not pathnames', () => {
    expect(parseRedirectMap(JSON.stringify({ constructor: { to: '/x' } }))).toEqual({});
  });
});

describe('lookupRedirect', () => {
  const map: RedirectMap = {
    '/old': rule('/new'),
    '/temp': rule('/elsewhere', 302),
    '/abs': rule('https://example.test/page'),
    '/ar/explicit': rule('/ar/own-target'),
    '/explicit': rule('/en-target'),
    '/already-ar': rule('/ar/target'),
  };

  it('returns null when no rule matches, and matches the pathname exactly', () => {
    expect(lookupRedirect('/nope', map)).toBeNull();
    expect(lookupRedirect('/old/child', map)).toBeNull();
    expect(lookupRedirect('/older', map)).toBeNull();
  });

  it('returns the matching rule with its status', () => {
    expect(lookupRedirect('/old', map)).toEqual(rule('/new'));
    expect(lookupRedirect('/temp', map)).toEqual(rule('/elsewhere', 302));
  });

  it('matches a trailing-slash request to the normalised key', () => {
    expect(lookupRedirect('/old/', map)).toEqual(rule('/new'));
  });

  it('does not resolve inherited Object.prototype keys as redirect rules', () => {
    for (const path of ['/constructor', '/toString', '/__proto__', '/valueOf']) {
      expect(lookupRedirect(path, map), path).toBeNull();
    }
  });

  it('/ar twin fallback: an Arabic URL uses the English rule, re-localised', () => {
    expect(lookupRedirect('/ar/old', map)).toEqual(rule('/ar/new'));
    expect(lookupRedirect('/ar/old/', map)).toEqual(rule('/ar/new'));
    expect(lookupRedirect('/ar/temp', map)).toEqual(rule('/ar/elsewhere', 302));
  });

  it('/ar twin fallback: an explicit /ar row wins over the fallback', () => {
    expect(lookupRedirect('/ar/explicit', map)).toEqual(rule('/ar/own-target'));
  });

  it('/ar twin fallback: an absolute target, or one already under /ar, is untouched', () => {
    expect(lookupRedirect('/ar/abs', map)).toEqual(rule('https://example.test/page'));
    expect(lookupRedirect('/ar/already-ar', map)).toEqual(rule('/ar/target'));
  });

  it('/ar twin fallback never applies to an English URL', () => {
    expect(lookupRedirect('/explicit-missing', map)).toBeNull();
    expect(lookupRedirect('/ar', map)).toBeNull();
  });

  it('finds a source authored in Arabic from the percent-encoded request path', () => {
    const arabic = buildRedirectMap([{ source_path: '/عن', target_path: '/about' }]);
    expect(lookupRedirect('/%D8%B9%D9%86', arabic)).toEqual(rule('/about'));
    expect(lookupRedirect('/ar/%D8%B9%D9%86', arabic)).toEqual(rule('/ar/about'));
    expect(
      lookupRedirect('/a%20b', buildRedirectMap([{ source_path: '/a b', target_path: '/c' }])),
    ).toEqual(rule('/c'));
  });

  it('never answers a rule that resolves to the requested path itself (review finding 2)', () => {
    // `/x → /ar/x`: the twin fallback re-localises the target onto `/ar/x` = the request
    // — an infinite redirect if served. The save path refuses the rule; the lookup is the
    // last line of defence for a snapshot that carries one anyway.
    const twin: RedirectMap = { '/x': rule('/ar/x') };
    expect(lookupRedirect('/ar/x', twin)).toBeNull();
    expect(lookupRedirect('/x', twin)).toEqual(rule('/ar/x'));
    // …and an explicit self-reference hidden by a query or a trailing slash.
    expect(lookupRedirect('/self', { '/self': rule('/self?tab=1') })).toBeNull();
    expect(lookupRedirect('/self/', { '/self': rule('/self/') })).toBeNull();
  });
});

describe('redirectResponse', () => {
  const url = (s: string) => new URL(`https://www.example.test${s}`);

  it('is a bare 30x with Location and the shared Cache-Control', () => {
    const res = redirectResponse(rule('/new', 308), url('/old'));
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('/new');
    expect(res.headers.get('cache-control')).toBe(REDIRECT_CACHE_CONTROL);
    expect(res.body).toBeNull();
  });

  it('carries the request query when the target has none', () => {
    const res = redirectResponse(rule('/new'), url('/old?utm=x&b=1'));
    expect(res.headers.get('location')).toBe('/new?utm=x&b=1');
  });

  it('a target with its own query wins over the request query', () => {
    const res = redirectResponse(rule('/new?tab=2'), url('/old?utm=x'));
    expect(res.headers.get('location')).toBe('/new?tab=2');
  });

  it('puts the request query BEFORE a target fragment (review finding 1)', () => {
    // `/services#branding?utm=x` would make the query part of the fragment — never sent
    // to the server, and the campaign tag lost.
    expect(redirectLocation(rule('/services#branding'), '?utm=x')).toBe('/services?utm=x#branding');
    expect(redirectLocation(rule('/services#branding'), '')).toBe('/services#branding');
    expect(redirectLocation(rule('/new'), '?utm=x')).toBe('/new?utm=x');
    // Both: the target's own query wins, and its fragment stays where it was.
    expect(redirectLocation(rule('/new?tab=2#top'), '?utm=x')).toBe('/new?tab=2#top');
    const res = redirectResponse(rule('/services#branding'), url('/old?utm=x&b=1'));
    expect(res.headers.get('location')).toBe('/services?utm=x&b=1#branding');
  });

  it('a 302 is never cached; 301 and 308 carry the day-long lifetime (review finding 6)', () => {
    expect(redirectResponse(rule('/new', 302), url('/old')).headers.get('cache-control')).toBe(
      TEMPORARY_REDIRECT_CACHE_CONTROL,
    );
    expect(TEMPORARY_REDIRECT_CACHE_CONTROL).toBe('no-cache');
    for (const status of [301, 308] as const) {
      expect(
        redirectResponse(rule('/new', status), url('/old')).headers.get('cache-control'),
        String(status),
      ).toBe(REDIRECT_CACHE_CONTROL);
    }
  });

  it('the Cache-Control equals the retired-services map (one constant, two consumers)', () => {
    expect(REDIRECT_CACHE_CONTROL).toBe('public, max-age=86400');
    expect(RETIRED_CACHE_CONTROL).toBe(REDIRECT_CACHE_CONTROL);
  });
});

describe('putRedirectMap / getRedirectMap through KV', () => {
  it('round-trips the map under the documented key', async () => {
    const map = { '/old': rule('/new') };
    expect(await putRedirectMap(env, map)).toBe(true);
    expect(__kv.has(REDIRECTS_KV_KEY)).toBe(true);
    expect(await getRedirectMap(env)).toEqual(map);
  });

  it('reads with cacheTtl 60 — the design is a TTL, not a purge', async () => {
    const get = vi.fn(async () => null);
    await getRedirectMap({ SESSION: { get } as unknown as KVNamespace });
    expect(get).toHaveBeenCalledWith(REDIRECTS_KV_KEY, { cacheTtl: REDIRECT_MAP_CACHE_TTL_S });
    expect(REDIRECT_MAP_CACHE_TTL_S).toBe(60);
  });

  it('is empty when the key is absent or the binding is missing (pre-provisioning)', async () => {
    expect(await getRedirectMap(env)).toEqual({});
    expect(await getRedirectMap({})).toEqual({});
  });

  it('fails OPEN when KV throws on read, and reports false when it throws on write', async () => {
    const broken = {
      SESSION: {
        get: async () => {
          throw new Error('kv down');
        },
        put: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace,
    };
    expect(await getRedirectMap(broken)).toEqual({});
    expect(await putRedirectMap(broken, {})).toBe(false);
    expect(await putRedirectMap({}, {})).toBe(false);
  });
});
