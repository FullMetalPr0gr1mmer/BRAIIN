import type { NavNode } from '@/lib/data/navigation';

// The menus shown until the CMS has navigation rows, and whenever the query fails — so
// the site is never navigation-less. These are the SAME lists supabase/seed-data/
// 25-navigation.json and 26-navigation-join.json seed (tests/seed/seeds.spec.ts fails if
// they drift), which is what makes "the fallback" and "a freshly seeded site" look
// identical.
//
// UI v2 (the Brain Station UI mockup): Home · About · Our Work · Services · Contact us ·
// Join, with Contact us as the key link — the one still visible at <=900px. Join is the
// LAST item of both menus (the mockup's header order; not a key link). Insights moved from
// the header to the footer. Round 2: Services is the Services page (/services), no longer
// the home section (/#services).

type Entry = { href: string; en: string; ar: string; key?: boolean };

function toNodes(prefix: string, entries: readonly Entry[]): NavNode[] {
  return entries.map((e, i) => ({
    id: `${prefix}${i + 1}`,
    parent_id: null,
    href: e.href,
    sort_order: i + 1,
    is_key: e.key === true,
    children: [],
    label: { en: e.en, ar: e.ar },
  }));
}

export const HEADER_FALLBACK: NavNode[] = toNodes('fallback-h', [
  { href: '/', en: 'Home', ar: 'الرئيسية' },
  { href: '/about', en: 'About', ar: 'من نحن' },
  { href: '/portfolio', en: 'Our Work', ar: 'أعمالنا' },
  { href: '/services', en: 'Services', ar: 'الخدمات' },
  { href: '/contact', en: 'Contact us', ar: 'تواصل معنا', key: true },
  { href: '/join', en: 'Join', ar: 'انضم' },
]);

export const FOOTER_FALLBACK: NavNode[] = toNodes('fallback-f', [
  { href: '/services', en: 'Services', ar: 'الخدمات' },
  { href: '/portfolio', en: 'Our Work', ar: 'أعمالنا' },
  { href: '/creative-knowledge', en: 'Insights', ar: 'المعرفة' },
  { href: '/about', en: 'About', ar: 'من نحن' },
  { href: '/contact', en: 'Contact', ar: 'تواصل معنا' },
  { href: '/join', en: 'Join', ar: 'انضم' },
]);

/**
 * The legal links. NOT part of the CMS-authored set and never fallback-only: privacy,
 * terms and the cookie policy are PDPL obligations, so they are hard-wired rather than
 * left to whether someone remembered to author a nav row for them.
 */
export const LEGAL_LINKS = [
  { href: '/privacy', en: 'Privacy', ar: 'الخصوصية' },
  { href: '/terms', en: 'Terms', ar: 'الشروط' },
  { href: '/cookie-policy', en: 'Cookies', ar: 'ملفات الارتباط' },
] as const;
