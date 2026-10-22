import type { ApplyResult } from '@schemas/release';
import { COLLAPSE_TAG } from '@/lib/http/purge';
import { SEO_TARGET_TABLES } from './links';
import { RELEASE_REGISTRY, type RegistryEntry } from './registry';

// The Cache-Tags a published release purges (Admin v2 R7; docs/admin-v2/releases.md §5.1).
// SERVER ONLY (it reads the registry).
//
// The union over the release's items (as the apply answered them: every row it changed,
// cascades and the case-study link sets included, each with its image before and after) of
// the registry's tags for the row before AND after, so a renamed slug purges the old page as
// well as the new one, plus:
//   • a section's or a page visibility row's page, `page:<slug>` through its `page_id` (the
//     page's own item in the same release gives the slug, before and after, else one read);
//   • an SEO row's target, `service:`, `blog:`, `portfolio:` or `page:<slug>`;
//   • a case study's link sets (`portfolio_children`), its own `portfolio:<slug>`;
//   • `route:sitemap` and `route:llms` for ANY change of a page, service, discipline, case
//     study or post, and any change to page visibility or to search settings: the two list
//     only what is public and indexable, llms.txt names titles and descriptions, and the
//     sitemap's <lastmod> is the row's `updated_at`, which every applied edit moves (CLAUDE.md
//     Pillar 3, truthful dates). The design's narrower "URL changes" would leave a stale
//     lastmod after an edit;
//   • nothing for a redirect: its rule lives in the edge map (KV `site:redirects`), rebuilt
//     after the release, not in a cached page.
// Anything this cannot resolve (a row it cannot read, a type it does not know) is
// `tenant:default`, every Tier A page: purging too much is safe, too little is not. The purge
// (src/lib/http/purge.ts) sends more than 30 as `tenant:default` too.
//
// tests/lib/releaseTags.spec.ts holds every tag this can emit to one a route stamps
// (src/lib/http/routeTags.ts, src/lib/sections/reads.ts).

type Row = Record<string, unknown>;
type Item = ApplyResult['items'][number];

/** The tables a tag needs a slug from, and the tag's kind for each. */
export const SLUG_TABLES = {
  pages: 'page',
  services: 'service',
  blog_posts: 'blog',
  portfolio: 'portfolio',
} as const;
export type SlugTable = keyof typeof SLUG_TABLES;

/** Reads `id,slug` of these rows (the caller's client, the caller's tenant), in one go. */
export type SlugLookup = (
  reads: readonly { table: SlugTable; ids: readonly string[] }[],
) => Promise<ReadonlyMap<SlugTable, ReadonlyMap<string, string>>>;

/** Types whose every change moves the sitemap and llms.txt (what is listed, and how). */
const LISTING_TYPES = new Set([
  'page',
  'service',
  'discipline',
  'portfolio',
  'blog_post',
  'page_visibility',
  'entity_seo',
]);

export const SITEMAP_TAGS = ['route:sitemap', 'route:llms'] as const;

const imageOf = (item: Item, side: 'before' | 'after'): Row | null =>
  side in item ? ((item as Record<string, unknown>)[side] as Row | null) : null;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** Whether this item moves what the sitemap or llms.txt shows. */
function movesListing(item: Item): boolean {
  return LISTING_TYPES.has(item.entity_type);
}

export interface ReleaseTagSet {
  /** Every tag, each once, in the order found (more than 30 is collapsed by the purge). */
  tags: string[];
  /** Something could not be resolved, so `tenant:default` stands in for it. */
  collapsed: boolean;
}

/**
 * The tags a release's items purge. `lookup` is asked once, for the slugs the items' own images
 * do not carry; when it fails, those tags are `tenant:default`. Never throws.
 */
export async function releaseTags(
  items: readonly Item[],
  lookup: SlugLookup,
): Promise<ReleaseTagSet> {
  const tags = new Set<string>();
  let collapsed = false;

  // Slugs the release's own images carry: a page renamed here gives both of its slugs.
  const known = new Map<string, Set<string>>();
  const remember = (table: SlugTable, id: unknown, slug: unknown) => {
    const key = `${table}:${String(id)}`;
    const s = str(slug);
    if (!s) return;
    const set = known.get(key) ?? new Set<string>();
    set.add(s);
    known.set(key, set);
  };
  const TYPE_TABLE: Record<string, SlugTable> = {
    page: 'pages',
    service: 'services',
    blog_post: 'blog_posts',
    portfolio: 'portfolio',
  };
  for (const item of items) {
    const table = TYPE_TABLE[item.entity_type];
    if (!table) continue;
    for (const side of ['before', 'after'] as const) {
      remember(table, item.entity_id, imageOf(item, side)?.['slug']);
    }
  }

  // What needs a read: a parent page, an SEO target, a case study's own slug.
  const wanted: { table: SlugTable; id: string }[] = [];
  const want = (table: SlugTable, id: unknown) => {
    const s = str(id);
    if (!s) return;
    if (known.has(`${table}:${s}`)) return;
    if (!wanted.some((w) => w.table === table && w.id === s)) wanted.push({ table, id: s });
  };
  const parents: { table: SlugTable; id: string }[] = [];
  const addParent = (table: SlugTable, id: unknown) => {
    const s = str(id);
    if (!s) return;
    parents.push({ table, id: s });
    want(table, s);
  };

  for (const item of items) {
    const entry = (RELEASE_REGISTRY as Readonly<Record<string, RegistryEntry | undefined>>)[
      item.entity_type
    ];
    if (item.entity_type === 'portfolio_children') {
      tags.add('portfolio:all');
      addParent('portfolio', item.entity_id);
      continue;
    }
    if (!entry) {
      // A type this release model does not know: purge everything rather than guess.
      tags.add(COLLAPSE_TAG);
      collapsed = true;
      continue;
    }
    const images = [imageOf(item, 'before'), imageOf(item, 'after')].filter(
      (row): row is Row => row !== null,
    );
    for (const row of images.length > 0 ? images : [null]) {
      for (const tag of entry.entityTags(row)) tags.add(tag);
      if (!row) continue;
      if (entry.tagParent) addParent('pages', row[entry.tagParent.column]);
      if (entry.tagTarget) {
        const target = SEO_TARGET_TABLES[String(row['entity_type'])] as SlugTable | undefined;
        if (target && target in SLUG_TABLES) addParent(target, row['entity_id']);
        else {
          tags.add(COLLAPSE_TAG);
          collapsed = true;
        }
      }
    }
    if (movesListing(item)) for (const tag of SITEMAP_TAGS) tags.add(tag);
  }

  // One read for every slug the images did not carry.
  let read: ReadonlyMap<SlugTable, ReadonlyMap<string, string>> | null = new Map();
  if (wanted.length > 0) {
    const byTable = new Map<SlugTable, string[]>();
    for (const w of wanted) byTable.set(w.table, [...(byTable.get(w.table) ?? []), w.id]);
    try {
      read = await lookup([...byTable].map(([table, ids]) => ({ table, ids })));
    } catch {
      read = null;
    }
  }
  for (const { table, id } of parents) {
    const slugs = known.get(`${table}:${id}`);
    if (slugs) {
      for (const slug of slugs) tags.add(`${SLUG_TABLES[table]}:${slug}`);
      continue;
    }
    const slug = read?.get(table)?.get(id);
    // A row gone (a cascade from a removal in this release names a parent the images carry;
    // anything else unread) or a read that failed: purge everything for it.
    if (slug) tags.add(`${SLUG_TABLES[table]}:${slug}`);
    else {
      tags.add(COLLAPSE_TAG);
      collapsed = true;
    }
  }
  return { tags: [...tags], collapsed };
}
