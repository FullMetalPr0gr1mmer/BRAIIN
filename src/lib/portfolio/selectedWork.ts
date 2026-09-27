// Home "Selected work" (UI v2 PR7): which featured projects the band shows, and where.
//
// The pool is the published `is_featured` projects in `sort_order` (getPortfolioCards
// ({featuredOnly: true})). The first is the featured project, the next two the cards. An
// editor may re-pick with `featuredSlug` / `cardSlugs`, but only AMONG the featured
// projects: a slug that is unknown, unpublished or unfeatured is ignored and the default
// order fills in — a stale pick degrades, it never empties the band.

/** How many project cards sit under the featured project (the design's two-up grid). */
export const SELECTED_WORK_CARDS = 2;

export interface SelectedWorkPick<T> {
  featured: T;
  cards: T[];
}

export function pickSelectedWork<T extends { slug: string }>(
  pool: readonly T[],
  opts: { featuredSlug?: string | undefined; cardSlugs?: readonly string[] | undefined } = {},
): SelectedWorkPick<T> | null {
  const first = pool[0];
  if (!first) return null;
  const bySlug = new Map(pool.map((p) => [p.slug, p]));
  const featured = (opts.featuredSlug && bySlug.get(opts.featuredSlug)) || first;

  const cards: T[] = [];
  const take = (p: T | undefined) => {
    if (p && p !== featured && !cards.includes(p) && cards.length < SELECTED_WORK_CARDS) {
      cards.push(p);
    }
  };
  for (const slug of opts.cardSlugs ?? []) take(bySlug.get(slug));
  for (const p of pool) take(p);
  return { featured, cards };
}
