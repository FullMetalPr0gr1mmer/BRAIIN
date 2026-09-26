// Page <title> composition — ONE rule for every public route.
//
// The brand is data (`site_profile.brand_name`), so no title may spell it out: the
// template names it `%brand%` and this module substitutes it. The UI v2 format is the
// mockup's `Braiin Statiion | About` — brand first — and that is the default whenever the
// SEO role has not authored a template (`seo_defaults.title_template`).
//
// Replacements go through a FUNCTION, never a replacement string: `'%s'.replace('%s', t)`
// interprets `$&`, `$1`, `$$` inside `t`, so a project called "Save $& now" would come out
// as "Save %s now". Content titles are CMS-authored; they must reach the head verbatim.

export const DEFAULT_TITLE_TEMPLATE = '%brand% | %s';

const BRAND_TOKEN = /%brand%/g;

/**
 * Applies a title template to one page title.
 *
 * - `%brand%` is substituted in the template AND in the page title, so an author can write
 *   `%brand% at Riyadh Season` in a per-entity override.
 * - A page title that already names the brand is used as is — a legacy override such as
 *   "Branding — Braiin Statiion" must not become "Braiin Statiion | Branding — Braiin
 *   Statiion".
 * - An empty page title yields the brand alone rather than a dangling "Braiin Statiion | ".
 * - A template without `%s` falls back to the default: applying it would give every page
 *   the same <title>, which is worse than ignoring it.
 */
export function applyTitleTemplate(template: string, pageTitle: string, brand: string): string {
  const page = pageTitle.replace(BRAND_TOKEN, () => brand).trim();
  if (!page) return brand;
  if (brand && page.toLocaleLowerCase().includes(brand.toLocaleLowerCase())) return page;
  const pattern = template.includes('%s') ? template : DEFAULT_TITLE_TEMPLATE;
  // ONE pass over the template for both tokens, so text already inserted is never
  // searched again: substituting the brand first let a brand containing "%s" capture the
  // page title ("Studio %s" → "Studio About | %s"). Only the first %s takes the title.
  let placed = false;
  return pattern.replace(/%brand%|%s/g, (token) => {
    if (token === '%brand%') return brand;
    if (placed) return token;
    placed = true;
    return page;
  });
}

/** The default format, for callers with no CMS template in hand. */
export function siteTitle(pageTitle: string, brand: string): string {
  return applyTitleTemplate(DEFAULT_TITLE_TEMPLATE, pageTitle, brand);
}
