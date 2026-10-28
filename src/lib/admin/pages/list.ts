import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { PAGE_PATHS, type VisibilityTemplate } from '@/lib/visibility/routes';
import { pagePath } from '@/lib/seo/entityPaths';
import type { VisibilityModeKey } from '../visibilityCopy';

// The pages list (Admin v2 E1, docs/admin-v2/ui.md "Pages list (/admin/pages; AV-25)").
// SERVER ONLY: /admin/pages reads it under the person's own RLS and renders the cards with no
// JavaScript. Four small reads in one round, plus the two template counts:
//   pages            every page of the tenant (id, slug, title, status, updated_at);
//   page_sections    each section's id and page, for "N sections" and for the pending badge
//                    (a pending change of a section names its section's id, not its page);
//   page_visibility  each page's mode and the two templates' (every CMS role reads it, 0057);
//   content_drafts   the pending changes of pages and sections: "Unpublished changes". While
//                    releases are off nothing is staged, so this read finds none and no card
//                    wears the badge (switching off needs every pending change discarded,
//                    R11), which is why the screen asks no flag first.
// The mapping is pure (`pageCards`, `templateCards`), so it is tested without a database
// (tests/lib/pagesList.spec.ts).

type Row = Record<string, unknown>;
type Bi = { en: string; ar: string };

export interface PageCard {
  id: string;
  slug: string;
  title: Bi;
  status: string;
  /** The page's public path, or null when no route renders it (E11 builds those). */
  path: string | null;
  sections: number;
  updatedAt: string | null;
  /** Who can see it on the live site (page visibility; public when it has no setting). */
  visibility: VisibilityModeKey;
  /** A pending change of the page or one of its sections (releases on only). */
  pending: boolean;
}

export interface TemplateCard {
  template: VisibilityTemplate;
  title: string;
  /** What it renders, in words: "28 services", "12 projects". */
  sub: string;
  /** Where its items are edited until the template editors (E3) arrive. */
  href: string;
  visibility: 'public' | 'hidden';
}

export interface PagesList {
  pages: PageCard[];
  templates: TemplateCard[];
}

const MODES: readonly VisibilityModeKey[] = ['public', 'hidden', 'link', 'password'];
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function titleOf(value: unknown, fallback: string): Bi {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
  const en = text(v['en']).trim() || fallback;
  return { en, ar: text(v['ar']).trim() };
}

function modeOf(value: unknown): VisibilityModeKey {
  return MODES.includes(value as VisibilityModeKey) ? (value as VisibilityModeKey) : 'public';
}

/** The routed pages in the route map's order (home first), then any other page by slug. */
function byRouteOrder(a: { slug: string }, b: { slug: string }): number {
  const order = Object.keys(PAGE_PATHS);
  const at = (slug: string) => {
    const i = order.indexOf(slug);
    return i === -1 ? order.length : i;
  };
  return at(a.slug) - at(b.slug) || a.slug.localeCompare(b.slug);
}

/**
 * The cards, from the four reads' rows. A section's pending change counts for the page it is
 * on now, and for the page its change names (a new section, or one moved between pages).
 */
export function pageCards(
  pages: readonly Row[],
  sections: readonly Row[],
  visibility: readonly Row[],
  drafts: readonly Row[],
): PageCard[] {
  const count = new Map<string, number>();
  const pageOfSection = new Map<string, string>();
  for (const s of sections) {
    const page = text(s['page_id']);
    pageOfSection.set(text(s['id']), page);
    count.set(page, (count.get(page) ?? 0) + 1);
  }
  const mode = new Map<string, VisibilityModeKey>();
  for (const v of visibility) {
    if (typeof v['page_id'] === 'string') mode.set(v['page_id'], modeOf(v['mode']));
  }
  const pending = new Set<string>();
  for (const d of drafts) {
    const id = text(d['entity_id']);
    if (d['entity_type'] === 'page') pending.add(id);
    if (d['entity_type'] === 'page_section') {
      const live = pageOfSection.get(id);
      if (live) pending.add(live);
      const named = text(d['page_id']);
      if (named) pending.add(named);
    }
  }
  return pages
    .map((p): PageCard => {
      const id = text(p['id']);
      const slug = text(p['slug']).toLowerCase();
      return {
        id,
        slug,
        title: titleOf(p['title'], slug),
        status: text(p['status']) || 'draft',
        path: pagePath(slug),
        sections: count.get(id) ?? 0,
        updatedAt: typeof p['updated_at'] === 'string' ? p['updated_at'] : null,
        visibility: mode.get(id) ?? 'public',
        pending: pending.has(id),
      };
    })
    .sort(byRouteOrder);
}

/** "Template for 1 published service", "Template for 28 published services"; with no count, words. */
export function templateSub(n: number | null, one: string, many: string, unknown: string): string {
  return n === null ? unknown : `Template for ${n} ${n === 1 ? one : many}`;
}

/** The two template cards: the service page and the project page. */
export function templateCards(
  visibility: readonly Row[],
  counts: { services: number | null; projects: number | null },
): TemplateCard[] {
  const mode = (template: VisibilityTemplate): 'public' | 'hidden' =>
    visibility.some((v) => v['template'] === template && v['mode'] === 'hidden')
      ? 'hidden'
      : 'public';
  return [
    {
      template: 'service',
      title: 'Service page',
      sub: templateSub(
        counts.services,
        'published service',
        'published services',
        'Template for every service page',
      ),
      href: '/admin/services',
      visibility: mode('service'),
    },
    {
      template: 'case_study',
      title: 'Project page',
      sub: templateSub(
        counts.projects,
        'published project',
        'published projects',
        'Template for every project page',
      ),
      href: '/admin/portfolio',
      visibility: mode('case_study'),
    },
  ];
}

/** The most pages and sections one render lists (seven pages and 38 sections are seeded). */
export const LIST_CAP = { pages: 200, sections: 1000 } as const;

async function publishedCount(
  sb: SupabaseClient,
  auth: AuthContext,
  table: 'services' | 'portfolio',
): Promise<number | null> {
  const { count, error } = await sb
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', auth.tenantId)
    .eq('status', 'published');
  return error ? null : (count ?? 0);
}

/** The pages list for the signed-in person, read under their RLS. Throws on a failed read. */
export async function loadPagesList(sb: SupabaseClient, auth: AuthContext): Promise<PagesList> {
  const [pages, sections, visibility, drafts, services, projects] = await Promise.all([
    sb
      .from('pages')
      .select('id,slug,title,status,updated_at')
      .eq('tenant_id', auth.tenantId)
      .limit(LIST_CAP.pages),
    sb
      .from('page_sections')
      .select('id,page_id')
      .eq('tenant_id', auth.tenantId)
      .limit(LIST_CAP.sections),
    sb
      .from('page_visibility')
      .select('page_id,template,mode')
      .eq('tenant_id', auth.tenantId)
      .limit(50),
    sb
      .from('content_drafts')
      .select('entity_type,entity_id,page_id:payload->>pageId')
      .eq('tenant_id', auth.tenantId)
      .in('entity_type', ['page', 'page_section'])
      .limit(LIST_CAP.sections),
    publishedCount(sb, auth, 'services'),
    publishedCount(sb, auth, 'portfolio'),
  ]);
  for (const [name, read] of [
    ['pages', pages],
    ['page_sections', sections],
    ['page_visibility', visibility],
    ['content_drafts', drafts],
  ] as const) {
    if (read.error) throw new Error(`read ${name}: ${read.error.message}`);
  }
  const rows = (read: { data: unknown }) => (read.data ?? []) as Row[];
  return {
    pages: pageCards(rows(pages), rows(sections), rows(visibility), rows(drafts)),
    templates: templateCards(rows(visibility), { services, projects }),
  };
}
