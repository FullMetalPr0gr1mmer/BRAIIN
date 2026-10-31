import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';

// The site's theme as a visitor gets it (Admin v2 E4, AV-27): the loader (src/lib/data/
// theme.ts), read once per request through the content seam with anon's two columns, and
// `GET /styles/theme.css?v=<version>` (src/pages/styles/theme.css.ts). The address names the
// version, so the live one is immutable for a year and any other answers the CURRENT theme for
// a minute; every answer carries `site:chrome`, the tag a theme's publish purges; the body is
// one :root rule, or empty. No read ever fails a page: no theme is the brand's own look.

const state = vi.hoisted(() => ({
  configured: true,
  rows: [] as unknown[] | null,
  error: null as { code: string } | null,
  throws: false,
  calls: [] as string[],
}));

vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => state.configured }));
vi.mock('@/lib/data/source', () => ({
  contentClient: () => ({
    from: (table: string) => {
      state.calls.push(`from ${table}`);
      if (state.throws) throw new Error('network down');
      const chain = {
        select: (cols: string) => (state.calls.push(`select ${cols}`), chain),
        limit: async (n: number) => {
          state.calls.push(`limit ${n}`);
          return { data: state.error ? null : state.rows, error: state.error };
        },
      };
      return chain;
    },
  }),
}));

const { getActiveTheme, readActiveTheme, themeHref, THEME_COLUMNS, THEME_STYLESHEET_PATH } =
  await import('@/lib/data/theme');
const route = (await import('@/pages/styles/theme.css')) as unknown as {
  GET: APIRoute;
  IMMUTABLE: string;
  SHORT: string;
  prerender: boolean;
};

const TOKENS = {
  '--bs-klein': '#000000',
  '--bs-cobalt': '#615757',
  '--bs-sky': '#938a8d',
  '--bs-sky-soft': '#c3bdbf',
  '--bs-glow-klein': 'rgba(0, 0, 0, 0.42)',
  '--bs-glow-sky': 'rgba(147, 138, 141, 0.45)',
  '--bs-shadow-klein': '0 12px 38px rgba(0, 0, 0, 0.45)',
  '--bs-shadow-cobalt': '0 18px 48px rgba(97, 87, 87, 0.45)',
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.configured = true;
  state.rows = [];
  state.error = null;
  state.throws = false;
  state.calls = [];
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('readActiveTheme: the active v1 theme, as a visitor reads it', () => {
  it('asks for anon’s two columns, at most two rows, and nothing else', async () => {
    state.rows = [{ tokens: TOKENS, version: 7 }];
    expect(await readActiveTheme()).toEqual({ tokens: TOKENS, version: 7 });
    expect(THEME_COLUMNS).toBe('tokens,version');
    expect(state.calls).toEqual(['from custom_themes', 'select tokens,version', 'limit 2']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('no row, or no database: null, nothing reported', async () => {
    expect(await readActiveTheme()).toBeNull();
    state.configured = false;
    state.calls = [];
    expect(await readActiveTheme()).toBeNull();
    expect(state.calls).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['a refused read', () => (state.error = { code: '42501' })],
    ['a network failure', () => (state.throws = true)],
    [
      'two active themes',
      () =>
        (state.rows = [
          { tokens: TOKENS, version: 1 },
          { tokens: TOKENS, version: 2 },
        ]),
    ],
    [
      'tokens outside the closed set',
      () => (state.rows = [{ tokens: { '--x': 'red' }, version: 1 }]),
    ],
    [
      'a token that would break out',
      () => (state.rows = [{ tokens: { '--bs-klein': '#000;}body{' }, version: 1 }]),
    ],
    ['no version', () => (state.rows = [{ tokens: TOKENS }])],
    [
      'a version that is not a whole number',
      () => (state.rows = [{ tokens: TOKENS, version: 1.5 }]),
    ],
  ])('%s: null, reported (the page renders the brand’s look)', async (_name, arrange) => {
    arrange();
    expect(await readActiveTheme()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('custom_themes');
  });
});

describe('getActiveTheme: once per request; a theme that sets nothing is no theme', () => {
  it('reads once, however many ask', async () => {
    state.rows = [{ tokens: TOKENS, version: 3 }];
    const locals: { theme?: Promise<unknown> } = {};
    const [a, b] = await Promise.all([
      getActiveTheme(locals as never),
      getActiveTheme(locals as never),
    ]);
    expect(a).toEqual({ tokens: TOKENS, version: 3 });
    expect(b).toBe(a);
    expect(state.calls.filter((c) => c.startsWith('from'))).toHaveLength(1);
  });

  it('a theme reset to the brand’s own (no token) is null: no page links it', async () => {
    state.rows = [{ tokens: {}, version: 9 }];
    expect(await getActiveTheme({} as never)).toBeNull();
  });

  it('the address names the version', () => {
    expect(THEME_STYLESHEET_PATH).toBe('/styles/theme.css');
    expect(themeHref({ tokens: TOKENS, version: 12 })).toBe('/styles/theme.css?v=12');
  });
});

describe('GET /styles/theme.css', () => {
  const get = async (search: string) => {
    const url = new URL(`https://www.example.test/styles/theme.css${search}`);
    const res = (await route.GET({ url, locals: {} } as never)) as Response;
    return { res, body: await res.text() };
  };

  it('is rendered on demand (it reads the theme)', () => {
    expect(route.prerender).toBe(false);
  });

  it('the live version: one :root rule, CSS, immutable for a year, tagged site:chrome', async () => {
    state.rows = [{ tokens: TOKENS, version: 4 }];
    const { res, body } = await get('?v=4');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('cache-tag')).toBe('site:chrome');
    expect(body).toBe(
      ':root{--bs-klein:#000000;--bs-cobalt:#615757;--bs-sky:#938a8d;--bs-sky-soft:#c3bdbf;' +
        '--bs-glow-klein:rgba(0, 0, 0, 0.42);--bs-glow-sky:rgba(147, 138, 141, 0.45);' +
        '--bs-shadow-klein:0 12px 38px rgba(0, 0, 0, 0.45);' +
        '--bs-shadow-cobalt:0 18px 48px rgba(97, 87, 87, 0.45);}\n',
    );
  });

  it.each(['?v=3', '?v=5', '', '?v=4x', '?v=04&v=4'])(
    'any other address (%s) answers today’s theme for a minute only',
    async (search) => {
      state.rows = [{ tokens: TOKENS, version: 4 }];
      const { res, body } = await get(search);
      expect(res.headers.get('cache-control')).toBe('public, max-age=60, must-revalidate');
      expect(res.headers.get('cache-tag')).toBe('site:chrome');
      expect(body.startsWith(':root{--bs-klein:#000000;')).toBe(true);
    },
  );

  it.each([
    ['no theme', () => undefined],
    ['the brand’s own (no token)', () => (state.rows = [{ tokens: {}, version: 2 }])],
    ['a failed read', () => (state.throws = true)],
  ])('%s: an empty stylesheet, briefly cached, still tagged', async (_name, arrange) => {
    arrange();
    const { res, body } = await get('?v=2');
    expect(res.status).toBe(200);
    expect(body).toBe('');
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe(route.SHORT);
    expect(res.headers.get('cache-tag')).toBe('site:chrome');
  });
});
