import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { ROLE_CAPS, type Access } from '@/lib/authz/matrix';
import { writeSystemLog } from '@/lib/data/systemLog';
import { scrubPii } from '@/lib/log/scrub';
import type { ResourceConfig } from './resource';
import {
  aiQuestionResource,
  aiStyleResource,
  categoryResource,
  certificationResource,
  clientResource,
  disciplineResource,
  mediaResource,
  pageResource,
  portfolioResource,
  postResource,
  redirectResource,
  sectorResource,
  serviceCaseResource,
  serviceResource,
  statisticResource,
  teamResource,
  testimonialResource,
  themeResource,
} from './resources';

// The header search, server-side. One ilike per entity the caller's role can read,
// reusing each resource's own config so the entity list, its capabilities and its
// columns cannot drift from the CRUD endpoints they mirror.
//
// Deliberate boundaries:
//
//   - SERVER-RENDERED, not a live combobox. A GET form to /admin/search costs zero
//     client JS, is fully keyboard- and screen-reader-accessible for free, and cannot
//     leak a result the server did not authorize. Live suggestions are a later nicety.
//   - LEADS ARE EXCLUDED. Lead data is Admin+Developer-gated PII behind its own page
//     and audit trail; surfacing lead names in a cross-entity search box would create
//     a second, less-guarded read path — the exact thing §5's column gates exist to
//     prevent. The leads page has its own search.
//   - Per-entity capability gating uses the SAME rule as the sidebar (nav.ts): any of
//     the resource's read caps at full/view/meta. This is UX-layer filtering on top of
//     RLS — an entity the role cannot read returns zero rows from Postgres regardless.
//   - One ilike COLUMN per entity, no .or() chains: PostgREST's or-filter syntax gives
//     commas and parens meaning, which turns user input into filter grammar — the
//     search-safety class of bug §9(e) tests for. A single .ilike() argument is
//     parameter-encoded by supabase-js and carries no grammar.

export interface SearchTarget {
  config: ResourceConfig;
  /** URL segment of the editor route: /admin/<uiSlug>/<id>. */
  uiSlug: string;
  /** Group heading on the results page. */
  group: string;
  /**
   * Column matched by ilike: a text column, or `<col>->>en` for a bilingual JSONB one.
   * An ilike straight on a jsonb column is an SQL error, which the results page shows as
   * "could not be searched" (tests/lib/globalSearch.spec.ts checks every target against
   * the migrations).
   */
  column: string;
}

export const SEARCH_TARGETS: readonly SearchTarget[] = [
  { config: disciplineResource, uiSlug: 'disciplines', group: 'Disciplines', column: 'name->>en' },
  { config: serviceResource, uiSlug: 'services', group: 'Services', column: 'title->>en' },
  {
    config: serviceCaseResource,
    uiSlug: 'service-cases',
    group: 'Service case studies',
    column: 'title->>en',
  },
  { config: postResource, uiSlug: 'blog', group: 'Blog', column: 'title->>en' },
  { config: portfolioResource, uiSlug: 'portfolio', group: 'Our Work', column: 'title->>en' },
  { config: sectorResource, uiSlug: 'sectors', group: 'Sectors', column: 'slug' },
  { config: clientResource, uiSlug: 'clients', group: 'Clients', column: 'name->>en' },
  { config: testimonialResource, uiSlug: 'testimonials', group: 'Testimonials', column: 'slug' },
  { config: pageResource, uiSlug: 'pages', group: 'Pages', column: 'title->>en' },
  { config: categoryResource, uiSlug: 'categories', group: 'Categories', column: 'slug' },
  { config: teamResource, uiSlug: 'team', group: 'Team & authors', column: 'name->>en' },
  {
    config: certificationResource,
    uiSlug: 'certifications',
    group: 'Certifications',
    column: 'name->>en',
  },
  { config: statisticResource, uiSlug: 'statistics', group: 'Statistics', column: 'slug' },
  { config: redirectResource, uiSlug: 'redirects', group: 'Redirects', column: 'source_path' },
  { config: mediaResource, uiSlug: 'media', group: 'Media', column: 'storage_path' },
  { config: themeResource, uiSlug: 'themes', group: 'Themes', column: 'name' },
  {
    config: aiQuestionResource,
    uiSlug: 'ai-questions',
    group: 'Style-Finder questions',
    column: 'slug',
  },
  { config: aiStyleResource, uiSlug: 'ai-styles', group: 'Style-Finder styles', column: 'slug' },
];

const NAV_ACCESS: readonly Access[] = ['full', 'view', 'meta'];
const PER_ENTITY_LIMIT = 5;
export const MAX_QUERY_LENGTH = 64;

export interface SearchHit {
  href: string;
  label: string;
  detail: string | null;
}

export interface SearchGroup {
  group: string;
  hits: SearchHit[];
}

export interface SearchOutcome {
  groups: SearchGroup[];
  /**
   * Groups skipped because their query errored: a notice on the results page and in the
   * palette, and one system_logs row per search (DoD #6), never a silently shorter list.
   */
  failed: string[];
}

interface SearchFailure {
  group: string;
  table: string;
  code: string | null;
  error: string;
}

function canRead(auth: AuthContext, config: ResourceConfig): boolean {
  const caps = config.readCaps ?? [config.writeCap];
  return caps.some((cap) => NAV_ACCESS.includes(ROLE_CAPS[auth.role][cap]));
}

/**
 * A database error as the log may keep it: the search text taken out in every form it was
 * sent (PostgREST echoes a filter it cannot parse), then any e-mail or phone scrubbed.
 * What a person types into a search box can be a name or an address.
 */
export function logSafeError(message: string, terms: readonly string[]): string {
  let out = message;
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    if (term) out = out.split(term).join('[query]');
  }
  return scrubPii(out);
}

/** Escape ilike wildcards so a `%` in the query matches a literal `%`. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

/** Sanitise per the public-search rule (§7): length-capped, control chars stripped. */
export function cleanQuery(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

/** First human-readable string in a row value: bilingual JSONB `{en, ar}` or scalar. */
function textOf(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const doc = value as Record<string, unknown>;
    if (typeof doc['en'] === 'string' && doc['en'].length > 0) return doc['en'];
    if (typeof doc['ar'] === 'string' && doc['ar'].length > 0) return doc['ar'];
  }
  return null;
}

function labelOf(row: Record<string, unknown>): string {
  return (
    textOf(row['title']) ??
    textOf(row['name']) ??
    textOf(row['label']) ??
    textOf(row['slug']) ??
    textOf(row['source_path']) ??
    textOf(row['storage_path']) ??
    String(row['id'])
  );
}

function detailOf(row: Record<string, unknown>): string | null {
  const slug = textOf(row['slug']);
  if (slug) return `/${slug}`;
  return textOf(row['source_path']) ?? textOf(row['storage_path']);
}

export async function searchAdmin(
  sb: SupabaseClient,
  auth: AuthContext,
  query: string,
): Promise<SearchOutcome> {
  const q = cleanQuery(query);
  const groups: SearchGroup[] = [];
  const failed: string[] = [];
  if (q.length < 2) return { groups, failed };

  const pattern = `%${escapeLike(q)}%`;
  const failures: SearchFailure[] = [];

  // Sequential, not Promise.all: each call shares the caller's RLS-bound client, the
  // per-entity limit keeps every query trivial, and one slow entity failing fast-first
  // beats fourteen concurrent queries hitting the pooler from one keystroke.
  for (const target of SEARCH_TARGETS) {
    if (!canRead(auth, target.config)) continue;

    const { data, error } = await sb
      .from(target.config.table)
      .select(target.config.listColumns)
      .eq('tenant_id', auth.tenantId)
      .ilike(target.column, pattern)
      .limit(PER_ENTITY_LIMIT);

    if (error) {
      failed.push(target.group);
      failures.push({
        group: target.group,
        table: target.config.table,
        code: error.code || null,
        error: logSafeError(error.message, [pattern, escapeLike(q), q]),
      });
      continue;
    }
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    if (rows.length === 0) continue;

    groups.push({
      group: target.group,
      hits: rows.map((row) => ({
        href: `/admin/${target.uiSlug}/${String(row['id'])}`,
        label: labelOf(row),
        detail: detailOf(row),
      })),
    });
  }

  if (failures.length > 0) {
    // One row per search, awaited so the Worker does not drop it with the response.
    await writeSystemLog({
      level: 'error',
      source: 'admin:search',
      message: `Search could not query ${failures.map((f) => f.table).join(', ')}`,
      detail: { role: auth.role, failures },
    });
  }

  return { groups, failed };
}
