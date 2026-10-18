import { existsSync, readFileSync, readdirSync } from 'node:fs';

// Help guides written ahead of H11 (the help-guide catalog and app.put_help_guide): a slice
// built while H11 was in flight keeps its guide as `docs/admin-v2/guides/<slug>.json`, the
// nine keys exactly as the put will take them, and leaves a marked TODO in its migration where
// the put goes (Admin v2 U17 is the first). Until that put is wired, the database's set does
// not hold the text; tests/lib/helpCentre.spec.ts reads the set as it will be, the migrations'
// set with these guides in place, so every rule it holds the guides to (the schema, the
// capabilities, the screens, the Arabic block for block, the copy rules, PAGE_GUIDES) holds for
// them now. Once the put is wired (and the file removed), this reads nothing and changes
// nothing.

export const PENDING_GUIDES_DIR = 'docs/admin-v2/guides';

/** Each pending guide, raw, with the file it came from. */
export function pendingGuides(): { file: string; guide: unknown }[] {
  if (!existsSync(PENDING_GUIDES_DIR)) return [];
  return readdirSync(PENDING_GUIDES_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const file = `${PENDING_GUIDES_DIR}/${name}`;
      return { file, guide: JSON.parse(readFileSync(file, 'utf8')) as unknown };
    });
}

/**
 * The set with each pending guide in place: a guide of the same slug is replaced, a new one
 * added; ordered by place, then slug, as app.help_article_set() renders it.
 */
export function withPendingGuides<T extends { slug: string; sort_order: number }>(
  set: readonly T[],
  pending: readonly T[],
): T[] {
  const bySlug = new Map(set.map((guide) => [guide.slug, guide]));
  for (const guide of pending) bySlug.set(guide.slug, guide);
  return [...bySlug.values()].sort(
    (a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug),
  );
}
