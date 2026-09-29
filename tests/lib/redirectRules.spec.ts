import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import {
  STATIC_PUBLIC_ROUTES,
  chainRefusal,
  liveRouteRefusal,
  targetPathOf,
} from '@/lib/admin/redirectRules';

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
    // A backslash reads as a slash in an https URL: `/\host` IS `//host` (finding 3).
    expect(targetPathOf('/\\evil.test/x')).toBeNull();
  });
});

describe('liveRouteRefusal', () => {
  const auth = { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } as AuthContext;
  /** A client that records which table was read and answers "no live row". */
  const reading = () => {
    const tables: string[] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'limit']) builder[m] = () => builder;
    builder['maybeSingle'] = async () => ({ data: null, error: null });
    const sb = { from: (t: string) => (tables.push(t), builder) } as unknown as SupabaseClient;
    return { sb, tables };
  };

  it('a bare /<slug> consults no table — no route renders `pages` by slug (finding 5)', async () => {
    const { sb, tables } = reading();
    expect(await liveRouteRefusal('/faq', sb, auth)).toBeNull();
    expect(await liveRouteRefusal('/ar/faq', sb, auth)).toBeNull();
    expect(tables).toEqual([]);
  });

  it('a detail slug is checked against its table, on the logical path', async () => {
    const { sb, tables } = reading();
    expect(await liveRouteRefusal('/ar/services/logo', sb, auth)).toBeNull();
    expect(await liveRouteRefusal('/portfolio/x', sb, auth)).toBeNull();
    expect(await liveRouteRefusal('/creative-knowledge/y', sb, auth)).toBeNull();
    expect(tables).toEqual(['services', 'portfolio', 'blog_posts']);
  });

  it('a static route is refused without a read, in either language', async () => {
    const { sb, tables } = reading();
    expect((await liveRouteRefusal('/ar/about', sb, auth))?.field).toBe('sourcePath');
    expect(tables).toEqual([]);
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

  // The /ar twin fallback (R3-2) makes `/ar/old` answer the `/old` rule; the checks must
  // see the hops it adds (review findings 2 and 8).
  describe('through the /ar twin', () => {
    it('a rule cannot point at its own language twin — the fallback would loop it', () => {
      for (const [source, target] of [
        ['/x', '/ar/x'],
        ['/x', '/ar/x/'],
        ['/x', '/ar/x?utm=1'],
        ['/ar/x', '/x'],
        ['/', '/ar'],
      ]) {
        const refusal = chainRefusal(row(source!, target!), []);
        expect(refusal?.field, `${source} → ${target}`).toBe('targetPath');
        expect(refusal?.message).toContain('twin');
      }
    });

    it('a new English rule adds a hop to a rule that already points at its /ar twin', () => {
      // /campaign → /ar/old exists; /ar/old has no row, so it would answer /old → /new.
      const refusal = chainRefusal(row('/old', '/new'), [row('/campaign', '/ar/old', '1')]);
      expect(refusal?.field).toBe('sourcePath');
      expect(refusal?.message).toContain('/campaign');
    });

    it('a target under /ar chains through the English rule its twin would answer', () => {
      const refusal = chainRefusal(row('/campaign', '/ar/old'), [row('/old', '/new', '1')]);
      expect(refusal?.field).toBe('targetPath');
      expect(refusal?.message).toContain('/old');
      expect(refusal?.message).toContain('/new');
      expect(refusal?.message).toContain('follows that English rule');
    });

    it('an explicit /ar row wins over the fallback, as it does at the edge', () => {
      const refusal = chainRefusal(row('/campaign', '/ar/old'), [
        row('/old', '/new', '1'),
        row('/ar/old', '/ar/elsewhere', '2'),
      ]);
      expect(refusal?.message).toContain('/ar/elsewhere');
      expect(refusal?.message).not.toContain('follows that English rule');
    });

    it('a loop closed by the twin is named as one', () => {
      // /a → /ar/b → (fallback) /b → /a → …
      expect(chainRefusal(row('/b', '/a'), [row('/a', '/ar/b', '1')])?.message).toContain('loop');
    });

    it('an /ar source is not chained by a rule that targets the English page', () => {
      // A request to /x never consults an /ar/x row, so /y → /x does not hop again.
      expect(chainRefusal(row('/ar/x', '/q'), [row('/y', '/x', '1')])).toBeNull();
      // …and an English target does not chain through an /ar-only rule.
      expect(chainRefusal(row('/y', '/x'), [row('/ar/x', '/q', '1')])).toBeNull();
    });
  });
});
