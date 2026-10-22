import { describe, expect, it } from 'vitest';
import type { ApplyResult } from '@schemas/release';
import { RELEASE_ENTITY_TYPES } from '@schemas/release';
import { ALWAYS_TAGS } from '@/lib/http/cacheTags';
import { COLLAPSE_TAG, purgeTagSet } from '@/lib/http/purge';
import { LLMS_CACHE_TAG, SITEMAP_CACHE_TAG, TIER_A_ROUTES } from '@/lib/http/routeTags';
import { RELEASE_REGISTRY } from '@/lib/release/registry';
import {
  releaseTags,
  SITEMAP_TAGS,
  SLUG_TABLES,
  type SlugLookup,
  type SlugTable,
} from '@/lib/release/tags';
import { SECTION_READS } from '@/lib/sections/reads';
import { PAGE_PATHS } from '@/lib/visibility/routes';

// A release's Cache-Tags (Admin v2 R7, src/lib/release/tags.ts; releases.md §5.1): the union of
// every item's tags before AND after (a rename purges both URLs), a section's and a visibility
// row's page and an SEO row's target resolved in one read, the sitemap and llms.txt for any
// change to what they list, `tenant:default` for anything unresolved. The closure: every tag a
// release can emit is one a Tier A route stamps (src/lib/http/routeTags.ts and SECTION_READS),
// or the purge would clear nothing and the page would stay stale.

type Item = ApplyResult['items'][number];
type Row = Record<string, unknown>;

const id = (n: number) => `0f0f0f0f-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PAGE = id(1);
const SERVICE = id(2);

function item(
  type: string,
  op: 'create' | 'update' | 'delete',
  before: Row | null,
  after: Row | null,
  entityId = id(99),
): Item {
  return {
    id: 1,
    tenant_id: id(0),
    release_id: id(98),
    entity_type: type,
    entity_id: entityId,
    op,
    before,
    after,
    draft_id: null,
    actor_id: null,
    created_at: '2026-10-22T10:00:00+00:00',
  };
}

/** A lookup over fixed slugs, recording what it was asked. */
function lookupOf(slugs: Partial<Record<SlugTable, Record<string, string>>>) {
  const asked: { table: SlugTable; ids: readonly string[] }[] = [];
  const lookup: SlugLookup = async (reads) => {
    asked.push(...reads);
    return new Map(
      reads.map(({ table, ids }) => [
        table,
        new Map(
          ids.flatMap((rowId) => {
            const slug = slugs[table]?.[rowId];
            return slug ? [[rowId, slug] as const] : [];
          }),
        ),
      ]),
    );
  };
  return { lookup, asked };
}
const noLookup: SlugLookup = async () => {
  throw new Error('no read expected');
};

describe('one item', () => {
  it('a renamed service purges its old page and its new one, the lists, the sitemap and llms.txt', async () => {
    const { tags, collapsed } = await releaseTags(
      [item('service', 'update', { slug: 'logo' }, { slug: 'logo-design' }, SERVICE)],
      noLookup,
    );
    expect(collapsed).toBe(false);
    expect(tags).toEqual(
      expect.arrayContaining([
        'service:logo',
        'service:logo-design',
        'services:all',
        ...SITEMAP_TAGS,
      ]),
    );
  });

  it('any edit of a listed type moves the sitemap (its lastmod is updated_at), a counter does not', async () => {
    const edit = await releaseTags(
      [item('blog_post', 'update', { slug: 'a' }, { slug: 'a' })],
      noLookup,
    );
    expect(edit.tags).toEqual(expect.arrayContaining([...SITEMAP_TAGS]));
    const counter = await releaseTags([item('statistic', 'update', {}, {})], noLookup);
    expect(counter.tags).toEqual(['statistics:all']);
  });

  it('a section names its page through one read; the page’s own item in the release needs none', async () => {
    const { lookup, asked } = lookupOf({ pages: { [PAGE]: 'about' } });
    const section = item('page_section', 'update', { page_id: PAGE }, { page_id: PAGE });
    expect((await releaseTags([section], lookup)).tags).toEqual(['page:about']);
    expect(asked).toEqual([{ table: 'pages', ids: [PAGE] }]);

    const renamed = item('page', 'update', { slug: 'about' }, { slug: 'who-we-are' }, PAGE);
    const both = await releaseTags([renamed, section], noLookup);
    expect(both.tags).toEqual(expect.arrayContaining(['page:about', 'page:who-we-are']));
    expect(both.collapsed).toBe(false);
  });

  it('an SEO row purges its target; a target it cannot name purges everything', async () => {
    const { lookup } = lookupOf({ services: { [SERVICE]: 'logo' } });
    const seo = item(
      'entity_seo',
      'update',
      { entity_type: 'service', entity_id: SERVICE },
      { entity_type: 'service', entity_id: SERVICE },
    );
    const named = await releaseTags([seo], lookup);
    expect(named.tags).toEqual(expect.arrayContaining(['service:logo', ...SITEMAP_TAGS]));
    expect(named.collapsed).toBe(false);

    const strange = item('entity_seo', 'create', null, {
      entity_type: 'nowhere',
      entity_id: id(5),
    });
    expect((await releaseTags([strange], lookup)).tags).toContain(COLLAPSE_TAG);
  });

  it('a page visibility row purges its page, the menus, the sitemap and llms.txt; a template every page', async () => {
    const { lookup } = lookupOf({ pages: { [PAGE]: 'join' } });
    const page = await releaseTags(
      [item('page_visibility', 'update', { page_id: PAGE }, { page_id: PAGE, mode: 'hidden' })],
      lookup,
    );
    expect(page.tags.sort()).toEqual(['nav:all', 'page:join', ...SITEMAP_TAGS].sort());
    const template = await releaseTags(
      [item('page_visibility', 'update', { template: 'service' }, { template: 'service' })],
      noLookup,
    );
    expect(template.tags).toEqual(expect.arrayContaining(['services:all', 'nav:all']));
  });

  it('a redirect alone purges nothing: its rule lives in the edge map', async () => {
    const { tags } = await releaseTags(
      [item('redirect', 'create', null, { source_path: '/a', target_path: '/b' })],
      noLookup,
    );
    expect(tags).toEqual([]);
  });

  it('a team member (applied without images, O-12) is still team:all', async () => {
    const member = {
      entity_type: 'team_member',
      entity_id: id(7),
      op: 'update',
      draft_id: id(8),
    } as Item;
    expect((await releaseTags([member], noLookup)).tags).toEqual(['team:all']);
  });

  it('a case study’s link sets purge the project and the lists', async () => {
    const { lookup } = lookupOf({ portfolio: { [id(9)]: 'the-rider' } });
    const children = {
      ...item('portfolio_children', 'update', {}, {}, id(9)),
    } as Item;
    const { tags } = await releaseTags([children], lookup);
    expect(tags.sort()).toEqual(['portfolio:all', 'portfolio:the-rider'].sort());
  });

  it('what cannot be resolved purges everything: a failed read, a row gone, an unknown type', async () => {
    const failing: SlugLookup = async () => {
      throw new Error('down');
    };
    const section = item('page_section', 'delete', { page_id: PAGE }, null);
    expect(await releaseTags([section], failing)).toEqual({
      tags: [COLLAPSE_TAG],
      collapsed: true,
    });
    expect((await releaseTags([section], lookupOf({}).lookup)).tags).toEqual([COLLAPSE_TAG]);
    expect((await releaseTags([item('mystery', 'update', {}, {})], noLookup)).tags).toEqual([
      COLLAPSE_TAG,
    ]);
  });
});

describe('a large release', () => {
  it('more than 30 tags is purged as tenant:default', async () => {
    const items = Array.from({ length: 40 }, (_, n) =>
      item('service', 'update', { slug: `s${n}` }, { slug: `s${n}` }, id(100 + n)),
    );
    const { tags } = await releaseTags(items, noLookup);
    expect(tags.length).toBeGreaterThan(30);
    expect(purgeTagSet(tags)).toEqual([COLLAPSE_TAG]);
  });

  it('asks for every slug it needs in ONE read', async () => {
    const { lookup, asked } = lookupOf({
      pages: { [id(20)]: 'home', [id(21)]: 'contact' },
      services: { [SERVICE]: 'logo' },
    });
    const items = [
      item('page_section', 'update', { page_id: id(20) }, { page_id: id(20) }, id(30)),
      item('page_section', 'update', { page_id: id(21) }, { page_id: id(21) }, id(31)),
      item('entity_seo', 'update', null, { entity_type: 'service', entity_id: SERVICE }, id(32)),
    ];
    const { tags } = await releaseTags(items, lookup);
    expect(tags).toEqual(expect.arrayContaining(['page:home', 'page:contact', 'service:logo']));
    expect(asked).toHaveLength(2);
    expect(asked.map((a) => a.table).sort()).toEqual(['pages', 'services']);
  });
});

describe('the closure (every tag a release emits is stamped by a route)', () => {
  // What the routes stamp: the always tags, `route:<name>`, every route's entities, what the
  // composed pages' sections read, and the sitemap's and llms.txt's own tags. A parametric
  // route (a service, a case study, a post) stamps `<kind>:<its slug>`, shown with a sample.
  const stamped = new Set<string>([
    ...ALWAYS_TAGS,
    ...TIER_A_ROUTES.flatMap((r) => [`route:${r.route}`, ...r.entities]),
    ...Object.values(SECTION_READS).flat(),
    ...SITEMAP_CACHE_TAG.split(','),
    ...LLMS_CACHE_TAG.split(','),
  ]);
  const parametric = new Set(
    [...stamped].filter((t) => t.endsWith(':sample')).map((t) => t.split(':')[0]),
  );
  const isStamped = (tag: string) =>
    stamped.has(tag) || parametric.has(tag.split(':')[0]!) || tag === COLLAPSE_TAG;

  it('every registry type maps, and every tag it emits is stamped somewhere', async () => {
    const slugs = Object.fromEntries(
      (Object.keys(SLUG_TABLES) as SlugTable[]).map((table) => [
        table,
        { [PAGE]: table === 'pages' ? 'about' : 'sample' },
      ]),
    );
    const { lookup } = lookupOf(slugs);
    for (const type of RELEASE_ENTITY_TYPES) {
      expect(RELEASE_REGISTRY[type], type).toBeDefined();
      const row: Row = {
        slug: type === 'page' ? 'about' : 'sample',
        page_id: PAGE,
        entity_type: 'service',
        entity_id: PAGE,
        template: null,
      };
      for (const op of ['create', 'update', 'delete'] as const) {
        const { tags } = await releaseTags(
          [item(type, op, op === 'create' ? null : row, op === 'delete' ? null : row)],
          lookup,
        );
        for (const tag of tags) expect(isStamped(tag), `${type} ${op}: ${tag}`).toBe(true);
      }
    }
  });

  it('every CMS page slug is stamped as page:<slug> by its route', () => {
    for (const slug of Object.keys(PAGE_PATHS)) {
      expect(stamped.has(`page:${slug}`), slug).toBe(true);
    }
  });

  it('the sitemap and llms.txt carry the tags a listing change purges, and tenant:default', () => {
    for (const tag of SITEMAP_TAGS) {
      expect(`${SITEMAP_CACHE_TAG},${LLMS_CACHE_TAG}`.split(',')).toContain(tag);
    }
    expect(SITEMAP_CACHE_TAG.split(',')).toContain(COLLAPSE_TAG);
    expect(LLMS_CACHE_TAG.split(',')).toContain(COLLAPSE_TAG);
  });
});
