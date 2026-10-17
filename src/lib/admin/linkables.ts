import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { PAGE_PATHS } from '@/lib/visibility/routes';

// Where a link field can point (Admin v2 F5b, ui.md §2.6 "link"): the pages this site
// has, so an editor picks a target instead of typing a path and finding out later that it
// 404s.
//
// Two halves, on purpose:
//   CODE_ROUTES    the routes that exist because a file exists (src/pages): the home page
//                  and its siblings, the legal notices, and the in-page anchors code
//                  renders. No read, always there.
//   loadLinkables  what the CMS has PUBLISHED — a page's own title, every published
//                  service and project — read through the caller's own client, so RLS
//                  decides the rows and a draft never shows up as a link target.
//
// `isSiteHref` is the client's copy of the rule the server enforces (SafeHrefSchema in
// packages/schemas/media.ts; tests/lib/linkables.spec.ts holds the two equal on a table of
// inputs). The schema stays the gate: this only keeps the field from offering a link the
// save would refuse. `isHttpsHref` is the second rule, for the few schemas that take an
// external link (FieldDef.link.external, decision D3).
//
// The legal notices' labels are literals here rather than an import of `src/lib/legal`:
// that module is 16 KB of notice copy, and a link field ships in the admin bundle. The
// spec holds each label equal to the notice's own title, so a renamed notice fails CI.

export interface Linkable {
  href: string;
  label: { en: string; ar: string };
  group: 'page' | 'service' | 'project' | 'legal' | 'anchor';
}

/** How many published rows of one kind the picker offers (bounded: §4, the Free plan). */
const PER_KIND = 100;

const PAGE_LABELS: Readonly<Record<string, { en: string; ar: string }>> = {
  home: { en: 'Home', ar: 'الرئيسية' },
  about: { en: 'About', ar: 'من نحن' },
  contact: { en: 'Contact', ar: 'تواصل معنا' },
  join: { en: 'Join us', ar: 'انضم إلينا' },
  services: { en: 'Services', ar: 'الخدمات' },
  portfolio: { en: 'Our Work', ar: 'أعمالنا' },
  'portfolio-all': { en: 'All projects', ar: 'كل المشاريع' },
};

/**
 * The routes that are code, not content: every CMS page's path (the one map the menus,
 * the sitemap and page visibility read), the blog index, the three legal notices, and the
 * anchors a section renders on its own page.
 */
export const CODE_ROUTES: readonly Linkable[] = [
  ...Object.entries(PAGE_PATHS).map(([slug, path]): Linkable => ({
    href: path,
    label: PAGE_LABELS[slug] ?? { en: slug, ar: slug },
    group: 'page',
  })),
  {
    href: '/creative-knowledge',
    label: { en: 'Creative Knowledge', ar: 'المعرفة الإبداعية' },
    group: 'page',
  },
  { href: '/privacy', label: { en: 'Privacy Policy', ar: 'سياسة الخصوصية' }, group: 'legal' },
  { href: '/terms', label: { en: 'Terms of Service', ar: 'شروط الخدمة' }, group: 'legal' },
  {
    href: '/cookie-policy',
    label: { en: 'Cookie Policy', ar: 'سياسة ملفات تعريف الارتباط' },
    group: 'legal',
  },
  {
    href: '/contact#inquiry',
    label: { en: 'Contact: the inquiry form', ar: 'تواصل معنا: نموذج الطلب' },
    group: 'anchor',
  },
  {
    href: '/join#apply',
    label: { en: 'Join us: the application form', ar: 'انضم إلينا: نموذج التقديم' },
    group: 'anchor',
  },
  {
    href: '/services#categories',
    label: { en: 'Services: the disciplines', ar: 'الخدمات: التخصصات' },
    group: 'anchor',
  },
  {
    href: '/portfolio#projects',
    label: { en: 'Our Work: the projects', ar: 'أعمالنا: المشاريع' },
    group: 'anchor',
  },
];

/** SafeHrefSchema's own rule, for the field: `#anchor`, or `/path` with an optional one. */
export function isSiteHref(href: unknown): boolean {
  if (typeof href !== 'string') return false;
  const value = href.trim();
  if (value.length > 200) return false;
  return /^(#[a-z][a-z0-9-]*|\/(?!\/)[a-z0-9/_-]*(#[a-z][a-z0-9-]*)?)$/.test(value);
}

/** An external link the few schemas that take one accept: https, and nobody's credentials. */
export function isHttpsHref(href: unknown): boolean {
  if (typeof href !== 'string') return false;
  const value = href.trim();
  if (value.length > 300) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '';
}

/** A bilingual jsonb title → a label, falling back to the other language, then the slug. */
function labelOf(title: unknown, slug: string): { en: string; ar: string } {
  const doc = (title && typeof title === 'object' ? title : {}) as Record<string, unknown>;
  const en = typeof doc['en'] === 'string' && doc['en'].trim() !== '' ? doc['en'] : '';
  const ar = typeof doc['ar'] === 'string' && doc['ar'].trim() !== '' ? doc['ar'] : '';
  return { en: en || ar || slug, ar: ar || en || slug };
}

interface Row {
  slug?: unknown;
  title?: unknown;
}

/**
 * Every target a link field offers: the code routes, with a published CMS page's own
 * title where it has one, then the published services and projects. Read through the
 * CALLER's client, so a role that cannot see a table simply contributes nothing from it —
 * and a draft is never offered, because only published rows are asked for.
 *
 * Sequential and bounded, like the admin search: three small queries on one pooled
 * connection beat three concurrent ones from a Worker with 50 subrequests.
 */
export async function loadLinkables(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<readonly Linkable[]> {
  const pages = await sb
    .from('pages')
    .select('slug,title')
    .eq('tenant_id', auth.tenantId)
    .eq('status', 'published')
    .limit(PER_KIND);

  const titles = new Map<string, { en: string; ar: string }>();
  for (const row of (pages.data ?? []) as Row[]) {
    const slug = typeof row.slug === 'string' ? row.slug : '';
    if (slug) titles.set(slug, labelOf(row.title, slug));
  }

  const routes = CODE_ROUTES.map((route): Linkable => {
    const slug = Object.entries(PAGE_PATHS).find(([, path]) => path === route.href)?.[0];
    const title = slug ? titles.get(slug) : undefined;
    return title ? { ...route, label: title } : route;
  });

  const out: Linkable[] = [...routes];
  for (const [table, prefix, group] of [
    ['services', '/services', 'service'],
    ['portfolio', '/portfolio', 'project'],
  ] as const) {
    const { data } = await sb
      .from(table)
      .select('slug,title')
      .eq('tenant_id', auth.tenantId)
      .eq('status', 'published')
      .order('slug', { ascending: true })
      .limit(PER_KIND);
    for (const row of (data ?? []) as Row[]) {
      const slug = typeof row.slug === 'string' ? row.slug : '';
      const href = `${prefix}/${slug}`;
      // `all` is the All projects page, never a case study (CLAUDE.md §8).
      if (!slug || !isSiteHref(href) || out.some((link) => link.href === href)) continue;
      out.push({ href, label: labelOf(row.title, slug), group });
    }
  }
  return out;
}
