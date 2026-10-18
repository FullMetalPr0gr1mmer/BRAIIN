// What the site does for search by construction (Admin v2 U2, the SEO tab's "Built in"
// rows; the prototype's readiness list without its made-up figures). Facts of the code,
// not measurements: tests/lib/healthChecklist.spec.ts holds each to the file that makes it
// true, so a change there fails until this list is rewritten.

export interface BuiltInFact {
  id: string;
  text: string;
  detail: string;
}

export const SEO_BUILT_IN: readonly BuiltInFact[] = [
  {
    id: 'sitemap',
    text: "The sitemap lists the site's pages and every published service, project and post open to search engines",
    detail:
      'In English and Arabic, read from what is published, at most an hour behind, with the date each last changed. A page hidden from search, or pointing search engines at another address, is left out.',
  },
  {
    id: 'hreflang',
    text: 'English and Arabic pages point to each other',
    detail: 'Every page names its twin in the other language, with English as the default.',
  },
  {
    id: 'canonical',
    text: 'Each language names itself as the address to index',
    detail:
      'The English page points to itself and the Arabic page to itself. An address set under Advanced on the Pages tab is used in both languages, each in its own.',
  },
  {
    id: 'robots',
    text: 'Search and answer engines may read the site; AI training crawlers may not',
    detail:
      'robots.txt is written from one list in the code, and keeps every crawler out of the admin.',
  },
  {
    id: 'schema',
    text: 'Structured data is checked on every change',
    detail: 'Each type, in English and Arabic, before a change can ship.',
  },
];
