import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Which requests read the GA4 id, and so which pages may load GA4 (Admin v2 U15,
// src/lib/http/ga4.ts): the switch first, then a GET or HEAD of a listed public page route,
// answered publicly. The list is held to the files in src/pages both ways: every public page
// is either listed or named as never loading GA4, so a new page cannot be added without a
// decision.

const flag = vi.hoisted(() => ({ on: false }));
vi.mock('astro:env/server', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const mocked = { ...real };
  Object.defineProperty(mocked, 'GA4_NOTICE_READY', { get: () => flag.on, enumerable: true });
  return mocked;
});

const { GA4_ROUTES, NOT_GA4_ROUTES, ga4NoticeReady, ga4Reads, GA4_LOADER_SRC } =
  await import('@/lib/http/ga4');

/** Every page route in src/pages outside the admin, as Astro names it (`context.routePattern`). */
function pageRoutes(): string[] {
  const root = join(process.cwd(), 'src', 'pages');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (relative(root, path) !== 'admin' && relative(root, path) !== 'api') walk(path);
      } else if (entry.name.endsWith('.astro')) {
        const rel = relative(root, path)
          .split(sep)
          .join('/')
          .replace(/\.astro$/, '');
        const route = `/${rel}`.replace(/\/index$/, '') || '/';
        out.push(route);
      }
    }
  };
  walk(root);
  return out.sort();
}

const ask = (over: Partial<Parameters<typeof ga4Reads>[0]> = {}) =>
  ga4Reads({ method: 'GET', routePattern: '/', internal: false, private: false, ...over });

describe('the routes that load GA4', () => {
  it('are every public page route, but the ones named as never loading it, both ways', () => {
    const named = [...GA4_ROUTES, ...Object.keys(NOT_GA4_ROUTES)].sort();
    expect(named).toEqual(pageRoutes());
    for (const route of Object.keys(NOT_GA4_ROUTES))
      expect(GA4_ROUTES.has(route), route).toBe(false);
  });

  it('come in pairs: each English route with its Arabic twin', () => {
    for (const route of GA4_ROUTES) {
      if (route.startsWith('/ar')) continue;
      expect(GA4_ROUTES.has(route === '/' ? '/ar' : `/ar${route}`), route).toBe(true);
    }
    expect([...GA4_ROUTES].filter((r) => r === '/ar' || r.startsWith('/ar/'))).toHaveLength(
      GA4_ROUTES.size / 2,
    );
  });

  it('leave out search, whose address carries what a visitor typed, and the 404 pages', () => {
    for (const route of ['/search', '/ar/search', '/404', '/ar/404', '/ar/[...path]']) {
      expect(GA4_ROUTES.has(route), route).toBe(false);
      expect(NOT_GA4_ROUTES[route], route).toBeTruthy();
    }
  });

  it('leave out every page that renders the application form (applicant PII, Admin only)', () => {
    // By the page file, not by name: a route whose page renders JoinPage (the form's page)
    // must be named as never loading GA4, wherever it moves.
    const root = join(process.cwd(), 'src', 'pages');
    const withForm = pageRoutes().filter((route) => {
      const file = route === '/' ? 'index' : route.slice(1);
      for (const candidate of [`${file}.astro`, `${file}/index.astro`]) {
        try {
          return readFileSync(join(root, candidate), 'utf8').includes('JoinPage.astro');
        } catch {
          /* the other form of the file name */
        }
      }
      return false;
    });
    expect(withForm).toEqual(['/ar/join', '/join']);
    for (const route of withForm) {
      expect(GA4_ROUTES.has(route), route).toBe(false);
      expect(NOT_GA4_ROUTES[route], route).toMatch(/application form/);
    }
  });

  it('the loader is a file of our own, under the static scripts', () => {
    expect(GA4_LOADER_SRC).toBe('/scripts/ga4.js');
  });
});

describe('ga4Reads', () => {
  it('reads nothing while the switch is off, whatever the request', () => {
    flag.on = false;
    expect(ga4NoticeReady()).toBe(false);
    for (const route of GA4_ROUTES) expect(ask({ routePattern: route }), route).toBe(false);
  });

  it('with the switch on, reads for a GET or HEAD of a listed route answered publicly', () => {
    flag.on = true;
    try {
      expect(ga4NoticeReady()).toBe(true);
      for (const route of GA4_ROUTES) {
        expect(ask({ routePattern: route }), route).toBe(true);
        expect(ask({ routePattern: route, method: 'HEAD' }), route).toBe(true);
      }
    } finally {
      flag.on = false;
    }
  });

  it('with the switch on, never for any other request', () => {
    flag.on = true;
    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        expect(ask({ method }), method).toBe(false);
      }
      expect(ask({ internal: true }), 'admin, API, health or image').toBe(false);
      expect(ask({ private: true }), 'unlocked or bypassed').toBe(false);
      for (const routePattern of [
        null,
        undefined,
        '',
        '/search',
        '/404',
        '/join',
        '/ar/join',
        '/admin',
        '/admin/preview/[...path]',
        '/api/contact',
        '/sitemap.xml',
        '/robots.txt',
        '/llms.txt',
        '/healthz',
        '/creative-knowledge/rss.xml',
        '/services/',
      ]) {
        expect(ask({ routePattern }), String(routePattern)).toBe(false);
      }
    } finally {
      flag.on = false;
    }
  });
});
