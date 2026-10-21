import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';

// The titles of the items a page of the activity log touched (Admin v2 U13): "Updated the
// service" becomes "Updated the service “Logo design”". Read per entity type through the
// VIEWER's client, so RLS decides: a title the viewer may not read is simply absent.
//
// An allowlist, never the row's word: a row names its entity type, and a staff token may
// write a row of its own, so the table read is chosen here, from a fixed map, and never
// built from `entity_type`. People and their data never get a title, whatever the row says:
// a lead, a note, a job application, a profile, a contact (the CRM's, later) or an export
// is named by its kind alone (DENIED, held by tests/lib/activity.spec.ts). A lead's or an
// applicant's name in the log would put personal data in front of every reader of the log,
// and in a file that leaves the system.
//
// Cost (README P-15: 50 subrequests a request): one read per entity type on the page, at
// most MAX_TYPES of them, each for at most the page's 25 ids.

interface TitleSource {
  table: string;
  column: string;
  /** How the stored value reads as a title: a bilingual {en, ar} reads its English. */
  read?: (value: unknown) => string | null;
}

/** "aboutWho" reads "About who": a section has no name of its own, only its type. */
function sectionType(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(value)) return null;
  const words = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} section`;
}

const TITLE_SOURCES: Readonly<Record<string, TitleSource>> = {
  service: { table: 'services', column: 'title' },
  discipline: { table: 'disciplines', column: 'name' },
  portfolio: { table: 'portfolio', column: 'title' },
  service_case: { table: 'service_cases', column: 'title' },
  blog_post: { table: 'blog_posts', column: 'title' },
  page: { table: 'pages', column: 'title' },
  page_section: { table: 'page_sections', column: 'type', read: sectionType },
  testimonial: { table: 'testimonials', column: 'author_name' },
  client: { table: 'clients', column: 'name' },
  sector: { table: 'sectors', column: 'name' },
  team_member: { table: 'team_members', column: 'name' },
  statistic: { table: 'statistics', column: 'label' },
  certification: { table: 'certifications', column: 'name' },
  faq_item: { table: 'faq_items', column: 'question' },
  category: { table: 'categories', column: 'name' },
  nav_item: { table: 'navigation', column: 'label' },
  redirect: { table: 'redirects', column: 'source_path' },
  media_asset: { table: 'media_assets', column: 'display_name' },
  custom_theme: { table: 'custom_themes', column: 'name' },
};

/** Entity types that never get a title, whatever is added to TITLE_SOURCES. */
export const DENIED_TITLE_TYPES: readonly string[] = [
  'lead',
  'lead_note',
  'application',
  'job_application',
  'profile',
  'contact',
  'export',
  'auth',
];

/** The most entity types one page reads titles for. */
export const MAX_TYPES = 8;
/** The most ids one read asks for: a page of the log. */
export const MAX_IDS = 25;
/** A title longer than this is cut (a page is a list, not the item). */
export const MAX_TITLE = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** May this entity type's items be titled? */
export function hasTitleSource(type: string): boolean {
  return !DENIED_TITLE_TYPES.includes(type) && Object.hasOwn(TITLE_SOURCES, type);
}

/** The table and column a type's title is read from (for the spec), or null. */
export function titleSourceOf(type: string): { table: string; column: string } | null {
  if (!hasTitleSource(type)) return null;
  const source = TITLE_SOURCES[type]!;
  return { table: source.table, column: source.column };
}

/** A stored value as a title: a string, or the English of a bilingual pair; bounded. */
function asTitle(value: unknown): string | null {
  let text: unknown = value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    text = (value as Record<string, unknown>)['en'];
  }
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_TITLE ? `${trimmed.slice(0, MAX_TITLE - 1)}…` : trimmed;
}

/** `${type}:${id}`: the key a title is found by. */
export const titleKey = (type: string, id: string) => `${type}:${id}`;

/**
 * The titles of the items `refs` name, keyed by titleKey. One read per entity type (the
 * first MAX_TYPES types met), through `sb`, scoped to the viewer's tenant; ids that are not
 * uuids are skipped (a singleton's row is keyed by its tenant, and nothing else is titled).
 * A read that fails leaves its titles out: a title is a courtesy, never a reason to fail
 * the page.
 */
export async function resolveTitles(
  sb: SupabaseClient,
  auth: Pick<AuthContext, 'tenantId'>,
  refs: readonly ({ type: string; id: string } | null)[],
): Promise<Map<string, string>> {
  const byType = new Map<string, Set<string>>();
  for (const ref of refs) {
    if (!ref || !hasTitleSource(ref.type) || !UUID.test(ref.id)) continue;
    let ids = byType.get(ref.type);
    if (!ids) {
      if (byType.size >= MAX_TYPES) continue;
      ids = new Set();
      byType.set(ref.type, ids);
    }
    if (ids.size < MAX_IDS) ids.add(ref.id.toLowerCase());
  }

  const titles = new Map<string, string>();
  await Promise.all(
    [...byType].map(async ([type, ids]) => {
      const source = TITLE_SOURCES[type]!;
      try {
        const { data, error } = await sb
          .from(source.table)
          .select(`id,${source.column}`)
          .eq('tenant_id', auth.tenantId)
          .in('id', [...ids]);
        if (error || !Array.isArray(data)) return;
        for (const row of data as unknown as Record<string, unknown>[]) {
          const id = row['id'];
          if (typeof id !== 'string') continue;
          const title = (source.read ?? asTitle)(row[source.column]);
          if (title) titles.set(titleKey(type, id.toLowerCase()), title);
        }
      } catch {
        // Left out: see above.
      }
    }),
  );
  return titles;
}
