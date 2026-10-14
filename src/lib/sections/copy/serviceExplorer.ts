import { EXPLORER_DISCIPLINE_TOKEN, type ServiceExplorerSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// The /services explorer (ServiceExplorer.astro, Round 2), the design's copy (services.html
// `x.*`): the pill beside every service and each panel's closing button, which names the
// discipline through `{discipline}`. The disciplines and services are their tables'.

export const SERVICE_EXPLORER_COPY: BuiltIn<
  ServiceExplorerSectionContent,
  'inquireLabel' | 'startLabel'
> = {
  inquireLabel: { en: 'Inquire', ar: 'اطلب' },
  startLabel: {
    en: `Start your ${EXPLORER_DISCIPLINE_TOKEN} project`,
    ar: `ابدأ مشروع ${EXPLORER_DISCIPLINE_TOKEN}`,
  },
};

/** The labels the design never showed, which no content field holds. */
export const SERVICE_EXPLORER_LABELS = {
  /** The tablist's name: the pills are the only thing that names the set. */
  tabs: { en: 'Disciplines', ar: 'التخصصات' },
  /** The explorer region's name (it has no visible heading of its own). */
  region: { en: 'Services by discipline', ar: 'الخدمات حسب التخصص' },
  /** Screen-reader prefixes for the prev/next links, whose visible text is just a name. */
  prev: { en: 'Previous discipline: ', ar: 'التخصص السابق: ' },
  next: { en: 'Next discipline: ', ar: 'التخصص التالي: ' },
} as const;
