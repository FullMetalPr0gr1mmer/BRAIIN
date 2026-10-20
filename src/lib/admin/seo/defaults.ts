import type { Locale } from '@schemas/primitives';
import type { LocalizedProse, LocalizedText } from '@schemas/content';
import { pickLocale, pickLocaleStrict } from '@/lib/i18n';
import { PAGE_META, type MetaRoute } from '@/lib/seo/pageMeta';
import { caseDescription, caseTitle } from '@/lib/portfolio/casePage';
import { serviceDescription, serviceTitle } from '@/lib/services/page';
import type { SeoEntityType } from '@/lib/seo/entityPaths';

// A page's default title and description, as its public head computes them when the SEO
// role has written nothing (Admin v2 U10, AV-19 "merged with the PAGE_META defaults"): the
// same functions the routes pass to loadHead as `fallbackTitle` / `fallbackDescription`,
// never a second copy of their words, then the tenant's default title and description where
// the page has none (resolveSeo's order). SERVER ONLY (the SEO list route), so the page
// fallbacks' modules never reach an admin island. tests/lib/seoList.spec.ts holds the
// parity with loadHead per type and language.

/** The columns of a target's own row this module reads, by type. */
export interface TargetRow {
  id: string;
  slug: string;
  title: LocalizedText;
  status: string;
  /** services.blurb (the tagline). */
  blurb?: LocalizedProse | null;
  /** services.discipline. */
  discipline?: { name: LocalizedText } | null;
  /** portfolio. */
  teaser?: LocalizedText | null;
  summary?: LocalizedProse | null;
  project_type?: LocalizedText | null;
  /** blog_posts. */
  excerpt?: LocalizedProse | null;
}

/** A CMS page's slug → its PAGE_META entry (the section-composed routes). */
const META_ROUTE_OF_SLUG: Readonly<Record<string, MetaRoute>> = {
  home: 'home',
  about: 'about',
  contact: 'contact',
  join: 'join',
  services: 'services',
  portfolio: 'portfolio',
  'portfolio-all': 'portfolioAll',
};

/** The page's own title and description in one language, before the tenant defaults. */
export function pageFallback(
  type: SeoEntityType,
  row: TargetRow,
  locale: Locale,
): { title: string; description: string } {
  switch (type) {
    case 'page': {
      const route = META_ROUTE_OF_SLUG[row.slug];
      if (route) return PAGE_META[route][locale];
      return { title: pickLocale(row.title, locale), description: '' };
    }
    case 'service': {
      const service = {
        title: row.title,
        discipline: row.discipline ?? null,
        tagline: row.blurb ?? null,
      };
      return {
        title: serviceTitle(service as Parameters<typeof serviceTitle>[0], locale),
        description: serviceDescription(
          service as Parameters<typeof serviceDescription>[0],
          locale,
        ),
      };
    }
    case 'portfolio': {
      const study = {
        title: row.title,
        projectType: row.project_type ?? null,
        blurb: row.teaser ?? row.summary ?? null,
        summary: row.summary ?? null,
      };
      return {
        title: caseTitle(study as Parameters<typeof caseTitle>[0], locale),
        description: caseDescription(study as Parameters<typeof caseDescription>[0], locale),
      };
    }
    case 'blog_post':
      return {
        // BlogDetail.astro's own reads: the title (the slug when it has none), the excerpt
        // strictly in the page's language.
        title: pickLocale(row.title, locale, row.slug),
        description: pickLocaleStrict(row.excerpt, locale),
      };
  }
}

/** The tenant defaults' localized title and description ({en, ar} maps). */
export interface TenantDefaults {
  default_title?: Record<string, string> | null;
  default_description?: Record<string, string> | null;
}

/**
 * What the head shows when the page's SEO row leaves a field blank: the page's own value,
 * else the tenant default (resolveSeo's precedence below the override). Raw: `%brand%` is
 * left for the preview to fill, as resolveSeo does at render.
 */
export function defaultsFor(
  type: SeoEntityType,
  row: TargetRow,
  tenant: TenantDefaults | null,
): { title: { en: string; ar: string }; description: { en: string; ar: string } } {
  const one = (locale: Locale) => {
    const own = pageFallback(type, row, locale);
    return {
      title: own.title.trim() || (tenant?.default_title?.[locale] ?? '').trim(),
      description: own.description.trim() || (tenant?.default_description?.[locale] ?? '').trim(),
    };
  };
  const en = one('en');
  const ar = one('ar');
  return {
    title: { en: en.title, ar: ar.title },
    description: { en: en.description, ar: ar.description },
  };
}
