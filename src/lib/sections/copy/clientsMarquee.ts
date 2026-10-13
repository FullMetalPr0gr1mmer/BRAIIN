import type { ClientsMarqueeSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// "Selected clients" (ClientsMarquee.astro). The names are the clients table's, never copy.
// The note beside the heading has no fixed text: it is the studio's founding year from the
// public identity through the `since` pattern ("Since 2019"; no year, no note), and an
// authored `note` replaces it. The design writes the Arabic year in Arabic-Indic digits
// ("منذ ٢٠١٩"), so the component fills the Arabic token that way.

export const CLIENTS_MARQUEE_COPY: BuiltIn<ClientsMarqueeSectionContent, 'tag' | 'heading'> = {
  tag: { en: 'Selected clients', ar: 'عملاء مختارون' },
  heading: {
    en: "Trusted by the minds behind the region's biggest moments.",
    ar: 'بثقة العقول خلف أكبر لحظات المنطقة.',
  },
};

/** Text no content field holds: the note's pattern around the founding year. */
export const CLIENTS_MARQUEE_LABELS = {
  since: { en: 'Since {year}', ar: 'منذ {year}' },
} as const;
