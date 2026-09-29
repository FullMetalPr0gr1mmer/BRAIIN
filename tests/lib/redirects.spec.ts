import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  REDIRECTS_KV_KEY,
  REDIRECT_CACHE_CONTROL,
  REDIRECT_MAP_CACHE_TTL_S,
  RESERVED_REDIRECT_PREFIXES,
  buildRedirectMap,
  getRedirectMap,
  isReservedRedirectPath,
  lookupRedirect,
  normalizeRedirectPath,
  parseRedirectMap,
  putRedirectMap,
  redirectResponse,
  type RedirectMap,
} from '@/lib/http/redirects';
import { RETIRED_CACHE_CONTROL } from '@/lib/services/retired';
import { env, __kv } from '../stubs/cloudflare-workers';

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
    for (const p of ['/a/b/', '/a/b', '/']) {
      expect(normalizeRedirectPath(normalizeRedirectPath(p))).toBe(normalizeRedirectPath(p));
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
