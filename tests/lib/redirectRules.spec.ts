import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { STATIC_PUBLIC_ROUTES, chainRefusal, targetPathOf } from '@/lib/admin/redirectRules';

// The pure half of the redirect rules, and the drift guard for STATIC_PUBLIC_ROUTES: the
// list is code, the routes are files, and only this test keeps them equal. A page added
// without its entry could be "redirected" by a rule that never applies; an entry for a
// page that was removed would refuse a rule that should work.

const PAGES = join(process.cwd(), 'src', 'pages');

/** Every non-dynamic public page file under src/pages, as the route it answers. */
function walkPublicRoutes(dir = PAGES): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(PAGES, full).replace(/\\/g, '/');
    if (statSync(full).isDirectory()) {
      // The admin and its API are reserved paths; /ar/* twins mirror the English routes
      // and the rule is checked on the logical path.
      if (['admin', 'api', 'ar'].includes(rel)) continue;
      out.push(...walkPublicRoutes(full));
      continue;
    }
    if (rel.includes('[')) continue;
    const route = `/${rel}`
      .replace(/\.(astro|ts)$/, '')
      .replace(/\/index$/, '')
      .replace(/^$/, '/');
    out.push(route === '' ? '/' : route);
  }
  return out;
}

describe('STATIC_PUBLIC_ROUTES', () => {
  it('equals the non-dynamic public page files under src/pages', () => {
    const files = [...new Set(walkPublicRoutes())].sort();
    expect([...STATIC_PUBLIC_ROUTES].sort()).toEqual(files);
  });

  it('is sorted and locale-free', () => {
    expect([...STATIC_PUBLIC_ROUTES]).toEqual([...STATIC_PUBLIC_ROUTES].sort());
    for (const route of STATIC_PUBLIC_ROUTES) expect(route.startsWith('/ar')).toBe(false);
  });
});

describe('targetPathOf', () => {
  it('is the normalised path part of a site-relative target', () => {
    expect(targetPathOf('/new')).toBe('/new');
    expect(targetPathOf('/new/')).toBe('/new');
    expect(targetPathOf('/new?x=1#top')).toBe('/new');
    expect(targetPathOf('/services#branding')).toBe('/services');
  });

  it('is null for an absolute or protocol-relative target', () => {
    expect(targetPathOf('https://example.test/x')).toBeNull();
    expect(targetPathOf('//example.test/x')).toBeNull();
  });
});

describe('chainRefusal', () => {
  const row = (source_path: string, target_path: string, id?: string) => ({
    id,
    source_path,
    target_path,
  });

  it('a self-loop, however spelled', () => {
    for (const target of ['/a', '/a/', '/a?x', '/a#y']) {
      expect(chainRefusal(row('/a', target), [])?.field).toBe('targetPath');
    }
    expect(chainRefusal(row('/a/', '/a'), [])).not.toBeNull();
  });

  it('a target that is itself redirected (chain forward)', () => {
    const refusal = chainRefusal(row('/a', '/b'), [row('/b', '/c', '1')]);
    expect(refusal?.field).toBe('targetPath');
    expect(refusal?.message).toContain('/c');
  });

  it('a source an existing rule already points at (chain backward)', () => {
    const refusal = chainRefusal(row('/b', '/c'), [row('/a', '/b?utm=x', '1')]);
    expect(refusal?.field).toBe('sourcePath');
  });

  it('a loop between two rows names it as one', () => {
    expect(chainRefusal(row('/b', '/a'), [row('/a', '/b', '1')])?.message).toContain('loop');
  });

  it('ignores the merged row’s own stored version and unrelated rows', () => {
    expect(chainRefusal(row('/a', '/c', '1'), [row('/a', '/b', '1'), row('/x', '/y', '2')])).toBe(
      null,
    );
  });

  it('an absolute target cannot chain within the site', () => {
    expect(chainRefusal(row('/a', 'https://example.test/b'), [row('/b', '/c', '1')])).toBeNull();
  });
});
