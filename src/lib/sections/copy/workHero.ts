import type { WorkHeroSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// Our Work's opening banner (WorkHero.astro): the caption's tag. The project, its poster and
// its loop are the portfolio table's.

export const WORK_HERO_COPY: BuiltIn<WorkHeroSectionContent, 'tag'> = {
  tag: { en: 'Latest project', ar: 'أحدث مشروع' },
};

/**
 * Text no content field holds: the caption's client line for a client we may not name. It
 * is FacetTags' wording (and the service page's), so a hidden client reads the same
 * everywhere.
 */
export const WORK_HERO_LABELS = {
  confidential: { en: 'Confidential client', ar: 'عميل غير مُعلَن' },
} as const;
