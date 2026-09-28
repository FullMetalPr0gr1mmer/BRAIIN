// The home page's Cache-Tag entities (UI v2 PR7): everything its bands read, so a publish
// of any of it purges the cached home page — the page composition, the featured projects
// (and their sectors, clients and posters), the disciplines and services (the cards and the
// form's grouped select, Round 2), the marquee clients, the numbers and the quotes. One
// list, shared by / and /ar.
export const HOME_CACHE_ENTITIES = [
  'page:home',
  'portfolio:all',
  'sectors:all',
  'clients:all',
  'services:all',
  'disciplines:all',
  'statistics:all',
  'testimonials:all',
  'media:all',
] as const;
