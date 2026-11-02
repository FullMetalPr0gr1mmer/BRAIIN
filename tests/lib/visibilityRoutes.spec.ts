import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { translateWriteError } from '@/lib/admin/crud';
import { pageResource } from '@/lib/admin/resources/pages';
import {
  GATED_ROUTES,
  PAGE_PATHS,
  TEMPLATE_ROUTES,
  localizedPagePath,
  targetForPath,
  targetForRoute,
} from '@/lib/visibility/routes';

// Page visibility's route map (Admin v2 U14a) held to the files in src/pages. A wrong map
// would 404 a live page for every visitor, or leave a hidden one reachable: so every public
// route Astro can match is either gated here or named below as not gateable, and every gated
// route is a real page file. A new page fails this until someone decides which it is.

const PAGES = join(process.cwd(), 'src', 'pages');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** A page file's route pattern, as Astro builds it (`ar/index.astro` → `/ar`). */
function routeOf(file: string): string {
  const rel = relative(PAGES, file).replaceAll('\\', '/');
  const noExt = rel.replace(/\.(astro|ts)$/, '');
  const parts = noExt.split('/').filter((part) => part !== 'index');
  return `/${parts.join('/')}`;
}

const PUBLIC_ROUTES = files(PAGES)
  .map(routeOf)
  .filter((route) => !/^\/(api|admin)(\/|$)/.test(route))
  .sort();

/** Public routes page visibility does not gate: no CMS page row to hang a mode on. */
const NOT_GATEABLE = [
  // The 404s, and the Arabic catch-all that rewrites to its 404.
  '/404',
  '/ar/404',
  '/ar/[...path]',
  // The legal notices (PDPL obligations: always reachable) and the blog (out of scope).
  '/privacy',
  '/ar/privacy',
  '/terms',
  '/ar/terms',
  '/cookie-policy',
  '/ar/cookie-policy',
  '/creative-knowledge',
  '/ar/creative-knowledge',
  '/creative-knowledge/[slug]',
  '/ar/creative-knowledge/[slug]',
  '/creative-knowledge/rss.xml',
  '/ar/creative-knowledge/rss.xml',
  // Search, the discovery files and the probe.
  '/search',
  '/ar/search',
  '/sitemap.xml',
  '/llms.txt',
  '/robots.txt',
  // The web app manifests (Admin v2 U9): a file the head links, not a page.
  '/manifest.webmanifest',
  '/ar/manifest.webmanifest',
  // The theme's stylesheet (Admin v2 E4): a file the head links, never gated (the middleware
  // reads no visibility for it, as for /_image).
  '/styles/theme.css',
  '/healthz',
];
const ALL_NOT_GATEABLE = new Set(NOT_GATEABLE);

describe('the route map is the files in src/pages', () => {
  it('reads the page files (the walk is not empty)', () => {
    expect(PUBLIC_ROUTES).toContain('/');
    expect(PUBLIC_ROUTES).toContain('/ar');
    expect(PUBLIC_ROUTES).toContain('/services/[slug]');
    expect(PUBLIC_ROUTES).toContain('/ar/portfolio/[slug]');
  });

  it('every public route is gated or named as not gateable, never both', () => {
    for (const route of PUBLIC_ROUTES) {
      const gated = GATED_ROUTES.includes(route);
      expect(gated !== ALL_NOT_GATEABLE.has(route), route).toBe(true);
    }
  });

  it('every gated route, and every route named as not gateable, is a page file', () => {
    for (const route of GATED_ROUTES) expect(PUBLIC_ROUTES, route).toContain(route);
    for (const route of ALL_NOT_GATEABLE) expect(PUBLIC_ROUTES, route).toContain(route);
  });

  it('gates the seven CMS pages and the two templates, each in English and Arabic', () => {
    expect(GATED_ROUTES).toHaveLength(2 * (Object.keys(PAGE_PATHS).length + 2));
    expect(targetForRoute('/')).toEqual({ kind: 'page', slug: 'home' });
    expect(targetForRoute('/ar')).toEqual({ kind: 'page', slug: 'home' });
    expect(targetForRoute('/about')).toEqual({ kind: 'page', slug: 'about' });
    expect(targetForRoute('/ar/about')).toEqual({ kind: 'page', slug: 'about' });
    expect(targetForRoute('/portfolio/all')).toEqual({ kind: 'page', slug: 'portfolio-all' });
    expect(targetForRoute('/ar/portfolio/all')).toEqual({ kind: 'page', slug: 'portfolio-all' });
    expect(targetForRoute('/services/[slug]')).toEqual({ kind: 'template', template: 'service' });
    expect(targetForRoute('/ar/portfolio/[slug]')).toEqual({
      kind: 'template',
      template: 'case_study',
    });
  });

  it('a route it does not gate, an empty one and a request path are never a target', () => {
    for (const route of [...ALL_NOT_GATEABLE, '', undefined, null]) {
      expect(targetForRoute(route), String(route)).toBeNull();
    }
    // Paths are not patterns: a request for a service names its slug, never `[slug]`.
    expect(targetForRoute('/services/logo')).toBeNull();
    expect(targetForRoute('/about/')).toBeNull();
    expect(targetForRoute('/About')).toBeNull();
  });

  it('the CMS page slugs are the seeded pages', () => {
    const seed = JSON.parse(
      readFileSync(join(process.cwd(), 'supabase/seed-data/20-pages.json'), 'utf8'),
    ) as unknown;
    const slugs = JSON.stringify(seed).match(/"slug":"([a-z-]+)"/g) ?? [];
    expect(slugs.map((s) => s.slice(8, -1)).sort()).toEqual(Object.keys(PAGE_PATHS).sort());
  });

  it('the templates are the two detail routes', () => {
    expect(Object.values(TEMPLATE_ROUTES).sort()).toEqual([
      '/portfolio/[slug]',
      '/services/[slug]',
    ]);
  });
});

describe('paths, for the readers that hold paths', () => {
  it('a page path is its page, with or without a trailing slash', () => {
    expect(targetForPath('/')).toEqual({ kind: 'page', slug: 'home' });
    expect(targetForPath('/about')).toEqual({ kind: 'page', slug: 'about' });
    expect(targetForPath('/about/')).toEqual({ kind: 'page', slug: 'about' });
    expect(targetForPath('/portfolio/all')).toEqual({ kind: 'page', slug: 'portfolio-all' });
  });

  it('one segment under services or portfolio is a template child; deeper or other paths are not', () => {
    expect(targetForPath('/services/logo')).toEqual({ kind: 'template', template: 'service' });
    expect(targetForPath('/portfolio/the-rider')).toEqual({
      kind: 'template',
      template: 'case_study',
    });
    for (const path of ['/services/logo/x', '/creative-knowledge/x', '/privacy', '/search', '/x']) {
      expect(targetForPath(path), path).toBeNull();
    }
  });

  it('localises a page path as the routes do', () => {
    expect(localizedPagePath('home', 'en')).toBe('/');
    expect(localizedPagePath('home', 'ar')).toBe('/ar');
    expect(localizedPagePath('contact', 'ar')).toBe('/ar/contact');
    expect(localizedPagePath('portfolio-all', 'en')).toBe('/portfolio/all');
  });
});

describe('the route-bound slugs are frozen in the database (0057, pages_route_slug_fixed)', () => {
  const migration = readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '0057_page_visibility.sql'),
    'utf8',
  );
  const fn = /create or replace function app\.tg_pages_route_slug_fixed\(\)[\s\S]*?end \$\$;/.exec(
    migration,
  )?.[0];

  it('the trigger refuses a rename to or from exactly the route map’s slugs', () => {
    expect(fn, 'the trigger function is in 0057').toBeDefined();
    const lists = [...fn!.matchAll(/array\[([^\]]+)\]/g)].map((m) =>
      [...m[1]!.matchAll(/'([^']+)'/g)].map((q) => q[1]).sort(),
    );
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list).toEqual(Object.keys(PAGE_PATHS).sort());
    expect(migration).toMatch(
      /create trigger pages_route_slug_fixed before update of slug on public\.pages\s+for each row/,
    );
  });

  it('a refused rename reaches the editor on the slug field, in plain words', () => {
    const error = translateWriteError(
      {
        code: '23514',
        message: "This page's address is part of the site's routes and cannot change.",
        details: 'Failing row violates check constraint "pages_route_slug_fixed".',
      },
      'pages',
      'write',
      pageResource.constraintFields,
    );
    expect(error).toMatchObject({ field: 'slug' });
    expect(error.message).toMatch(/cannot change/);
  });
});
