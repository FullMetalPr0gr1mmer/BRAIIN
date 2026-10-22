import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECTION_TYPES } from '@schemas/sectionTypes';
import { ALWAYS_TAGS, MAX_TAGS, tierATags } from '@/lib/http/cacheTags';
import { MEDIA_PURGE_TAGS } from '@/lib/http/purge';
import { TIER_A_ROUTES } from '@/lib/http/routeTags';
import { RELEASE_REGISTRY } from '@/lib/release/registry';
import { SECTION_READS, sectionTags } from '@/lib/sections/reads';

// Page tags cover what a page renders (Admin v2 R7, releases.md §5.2): an editor can put a
// table-backed section on any composed page, so a composed route stamps its own tags plus
// what its sections read (src/lib/sections/reads.ts). Every Tier A route is in the one table
// (src/lib/http/routeTags.ts), within the 30 tags a response may carry with every section a
// page could hold; every tag a section reads is one something purges.

/** Every tag a release or a media save purges, but the per-slug ones. */
function purgeVocabulary(): Set<string> {
  const out = new Set<string>(MEDIA_PURGE_TAGS);
  for (const entry of Object.values(RELEASE_REGISTRY)) {
    for (const tag of [
      ...entry.entityTags(null),
      ...entry.entityTags({ slug: 'x', template: 'service' }),
      ...entry.entityTags({ slug: 'x', template: 'case_study' }),
    ]) {
      if (!tag.endsWith(':x')) out.add(tag);
    }
  }
  return out;
}

/** The page files under src/pages that are not the admin's or an API's. */
function publicPages(dir = 'src/pages'): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'admin' || name === 'api' ? [] : publicPages(path);
    }
    return /\.(astro|ts)$/.test(name) ? [path.split('\\').join('/')] : [];
  });
}

describe('SECTION_READS', () => {
  it('names every section type, and nothing else', () => {
    expect(Object.keys(SECTION_READS).sort()).toEqual([...SECTION_TYPES].sort());
  });

  it('reads only tags something purges (the registry’s vocabulary and media:all)', () => {
    const vocabulary = purgeVocabulary();
    for (const [type, tags] of Object.entries(SECTION_READS)) {
      for (const tag of tags) expect(vocabulary.has(tag), `${type}: ${tag}`).toBe(true);
    }
  });

  it('a page’s tags: each once, a hidden section adds nothing, an unknown type nothing', () => {
    expect(
      sectionTags([
        { type: 'statistics', visible: true },
        { type: 'team', visible: true },
        { type: 'leadership', visible: true },
        { type: 'certifications', visible: false },
        { type: 'nonsense' as never, visible: true },
        { type: '__proto__' as never, visible: true },
      ]).sort(),
    ).toEqual(['media:all', 'statistics:all', 'team:all']);
  });
});

describe('every Tier A route (src/lib/http/routeTags.ts)', () => {
  const all = [...new Set(Object.values(SECTION_READS).flat())];

  it('fits the 30 tags a response carries, with every section a composed page could hold', () => {
    for (const { route, entities, composed } of TIER_A_ROUTES) {
      const fixed = [...ALWAYS_TAGS, `route:${route}`, 'locale:ar'];
      const whole = new Set([...fixed, ...entities, ...(composed ? all : [])]);
      expect(whole.size, route).toBeLessThanOrEqual(MAX_TAGS);
      // So tierATags drops nothing.
      expect(
        tierATags({ route, locale: 'ar', entities: [...entities, ...(composed ? all : [])] })
          .length,
        route,
      ).toBe(whole.size);
    }
  });

  it('past 30, the always, route and locale tags are kept (only those, or a collapsed purge, reach it)', () => {
    const many = Array.from({ length: 40 }, (_, n) => `portfolio:p${n}`);
    const tags = tierATags({ route: 'x', locale: 'ar', entities: many });
    expect(tags).toHaveLength(MAX_TAGS);
    expect(tags).toEqual(
      expect.arrayContaining([...ALWAYS_TAGS, 'route:x', 'locale:ar', 'portfolio:p0']),
    );
  });

  it('About, Our Work, All projects and a case study stamp media:all (posters and images)', () => {
    for (const route of ['about', 'portfolio', 'portfolio-all', 'portfolio-item']) {
      expect(TIER_A_ROUTES.find((r) => r.route === route)?.entities, route).toContain('media:all');
    }
  });

  it('every Tier A route stamps media:all, whatever it lists: every head renders a media row', () => {
    // The default share image (seo_defaults.default_og_media, src/lib/seo/head.ts) is on every
    // page, and a media save purges media:all only (MEDIA_PURGE_TAGS): Join, the blog, search
    // and the legal pages read no media in their sections and must still carry it.
    for (const tag of MEDIA_PURGE_TAGS) expect(ALWAYS_TAGS, tag).toContain(tag);
    for (const { route, entities } of TIER_A_ROUTES) {
      for (const locale of ['en', 'ar'] as const) {
        const tags = tierATags({ route, locale, entities });
        for (const tag of MEDIA_PURGE_TAGS) expect(tags, `${route} ${locale}`).toContain(tag);
      }
    }
  });

  it('every Tier A page file names a route of the table, and a composed one stamps its sections', () => {
    const known = new Map(TIER_A_ROUTES.map((r) => [r.route, r]));
    const seen = new Set<string>();
    for (const file of [...publicPages(), 'src/components/LegalPage.astro']) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('setTierA(')) continue;
      const route = /setTierA\([^)]*?route:\s*'([^']+)'/s.exec(text)?.[1];
      expect(route, file).toBeDefined();
      const entry = known.get(route!);
      expect(entry, `${file}: ${route}`).toBeDefined();
      seen.add(route!);
      if (entry!.composed) expect(text, file).toContain('sectionTags(');
    }
    expect([...seen].sort()).toEqual([...known.keys()].sort());
  });
});
