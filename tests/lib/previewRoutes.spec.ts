import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fromPreviewPath,
  PREVIEW_ROUTES,
  previewRouteOf,
  toPreviewPath,
} from '@/lib/admin/preview/paths';
import { PREVIEW_ONLY_MAX, previewTarget, twinPath } from '@/lib/preview/routes';

// The preview's route map (Admin v2 R9; releases.md §9 previewRoutes): every Tier A page, EN
// and AR, is previewable, and nothing else is. Held to the page files in src/pages, so a new
// public page cannot ship without a decision here.

const PAGES = 'src/pages';

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? pageFiles(path)
      : [relative(PAGES, path).split(sep).join('/')];
  });
}

/** A page file → its route (`services/[slug].astro` → `/services/[slug]`). */
function routeOf(file: string): string {
  const bare = file.replace(/\.astro$/, '').replace(/(^|\/)index$/, '');
  return `/${bare}`.replace(/\/$/, '') || '/';
}

/** Public page files the preview does not render, and why. */
const NOT_PREVIEWED: Record<string, string> = {
  '/ar/[...path]': 'the Arabic catch-all: it only rewrites an unknown /ar path to /ar/404',
};

describe('the preview route map', () => {
  const publicPages = pageFiles(PAGES)
    .filter((f) => f.endsWith('.astro'))
    .filter((f) => !f.startsWith('admin/') && !f.startsWith('api/'))
    .map(routeOf);

  it('every public page file is previewed or named as not previewed', () => {
    expect(publicPages.length).toBeGreaterThanOrEqual(30);
    const routes = new Set(PREVIEW_ROUTES.map((r) => r.route));
    for (const route of publicPages) {
      if (route in NOT_PREVIEWED) continue;
      const english = route === '/ar' ? '/' : route.replace(/^\/ar\//, '/');
      expect(routes.has(english), route).toBe(true);
    }
  });

  it('every previewed route is a page file, in English and in Arabic', () => {
    for (const { route } of PREVIEW_ROUTES) {
      expect(publicPages, route).toContain(route);
      expect(publicPages, route).toContain(route === '/' ? '/ar' : `/ar${route}`);
    }
  });

  it('endpoints are never previewed', () => {
    for (const path of [
      '/sitemap.xml',
      '/llms.txt',
      '/robots.txt',
      '/healthz',
      '/creative-knowledge/rss.xml',
      '/ar/creative-knowledge/rss.xml',
      '/api/contact',
      '/admin',
      '/_image',
    ]) {
      expect(previewRouteOf(path), path).toBeNull();
    }
  });

  it('maps each kind of page, EN and AR, and prefers /portfolio/all over a case study', () => {
    expect(previewRouteOf('/')).toBe('/');
    expect(previewRouteOf('/ar')).toBe('/');
    expect(previewRouteOf('/ar/services/logo')).toBe('/services/[slug]');
    expect(previewRouteOf('/portfolio/all')).toBe('/portfolio/all');
    expect(previewRouteOf('/ar/portfolio/the-rider')).toBe('/portfolio/[slug]');
    expect(previewRouteOf('/creative-knowledge/a-b-c')).toBe('/creative-knowledge/[slug]');
    expect(previewRouteOf('/about/')).toBe('/about');
  });

  it('a slug is letters, digits and hyphens: nothing else reaches the rewrite', () => {
    for (const path of [
      '/services/a%2Fb',
      '/services/a%5Cb',
      '/services/..',
      '/services/a.b',
      '/services/-a',
      '/services/a/b',
      '/arabic',
      '/ar/ar',
      `/services/${'a'.repeat(121)}`,
    ]) {
      expect(previewRouteOf(path), path).toBeNull();
    }
  });
});

describe('preview path ↔ public path', () => {
  it('round-trips every kind of page', () => {
    for (const path of ['/', '/ar', '/about', '/ar/services/logo', '/portfolio/all', '/404']) {
      const preview = toPreviewPath(path)!;
      expect(preview.startsWith('/admin/preview')).toBe(true);
      expect(fromPreviewPath(preview)).toBe(path);
    }
    expect(toPreviewPath('/')).toBe('/admin/preview');
    expect(toPreviewPath('/portfolio/all?service=logo#x')).toBe(
      '/admin/preview/portfolio/all?service=logo#x',
    );
    expect(fromPreviewPath('/admin/preview/')).toBe('/');
  });

  it('refuses what is not a preview of a page', () => {
    expect(toPreviewPath('/api/contact')).toBeNull();
    expect(fromPreviewPath('/admin/previewx')).toBeNull();
    expect(fromPreviewPath('/admin/preview/sitemap.xml')).toBeNull();
    expect(fromPreviewPath('/admin/pages')).toBeNull();
  });
});

describe('previewTarget', () => {
  const at = (path: string) => previewTarget(new URL(`https://x.test${path}`));

  it('carries the query along, but not the preview’s own `only`', () => {
    const r = at(
      '/admin/preview/ar/portfolio/all?service=logo&only=0d000000-0000-4000-8000-000000000001',
    );
    expect(r).toEqual({
      ok: true,
      target: {
        publicPath: '/ar/portfolio/all?service=logo',
        pathname: '/ar/portfolio/all',
        logical: '/portfolio/all',
        locale: 'ar',
        route: '/portfolio/all',
        only: ['0d000000-0000-4000-8000-000000000001'],
      },
    });
  });

  it('reads `only` as a list of uuids, comma-separated or repeated, de-duplicated', () => {
    const a = '0d000000-0000-4000-8000-000000000001';
    const b = '0D000000-0000-4000-8000-000000000002';
    const r = at(`/admin/preview?only=${a},${b}&only=${a}`);
    expect(r.ok && r.target.only).toEqual([a, b.toLowerCase()]);
  });

  it('refuses a selection that is not uuids, or too long', () => {
    expect(at('/admin/preview?only=x')).toEqual({ ok: false, reason: 'bad-selection' });
    const many = Array.from(
      { length: PREVIEW_ONLY_MAX + 1 },
      (_, i) => `0d000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(at(`/admin/preview?only=${many.join(',')}`)).toEqual({
      ok: false,
      reason: 'bad-selection',
    });
  });

  it('a path that is not a page is not previewed', () => {
    expect(at('/admin/preview/robots.txt')).toEqual({ ok: false, reason: 'not-previewed' });
  });

  it('the twin is the same page in the other language', () => {
    expect(twinPath({ locale: 'en', logical: '/' })).toBe('/ar');
    expect(twinPath({ locale: 'en', logical: '/about' })).toBe('/ar/about');
    expect(twinPath({ locale: 'ar', logical: '/' })).toBe('/');
    expect(twinPath({ locale: 'ar', logical: '/services/logo' })).toBe('/services/logo');
  });
});
